$ErrorActionPreference = "Stop"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("youtube-study-install-test-" + [guid]::NewGuid())
$resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
New-Item -ItemType Directory -Path $resolvedTempRoot | Out-Null

try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "..\host\install.ps1") -Destination $resolvedTempRoot
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "..\host\native_host.bat") -Destination $resolvedTempRoot
    [System.IO.File]::WriteAllText((Join-Path $resolvedTempRoot "vault-path.txt"), "D:\old-vault")

    $fakePython = Join-Path $resolvedTempRoot "incomplete-python.cmd"
    [System.IO.File]::WriteAllText($fakePython, "@exit /b 1")
    $rejectedIncompletePython = $false
    try {
        & (Join-Path $resolvedTempRoot "install.ps1") `
            -ExtensionId ("a" * 32) `
            -PythonExe $fakePython `
            -SkipRegistry
    } catch {
        $rejectedIncompletePython = $true
    }
    if (-not $rejectedIncompletePython) {
        throw "Install must reject a Python runtime that cannot import host dependencies."
    }

    $pythonCandidates = @()
    $configuredPythonFile = Join-Path $PSScriptRoot "..\host\python-path.txt"
    if (Test-Path -LiteralPath $configuredPythonFile) {
        $pythonCandidates += [System.IO.File]::ReadAllText($configuredPythonFile).Trim()
    }
    $pythonCandidates += (Get-Command python -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
    $pythonExe = $null
    foreach ($candidate in ($pythonCandidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate)) {
            continue
        }
        & $candidate -c "import json, pathlib, socket, subprocess, urllib.request" 2>$null
        if ($LASTEXITCODE -eq 0) {
            $pythonExe = $candidate
            break
        }
    }
    if (-not $pythonExe) {
        throw "No complete Python runtime is available for the install test."
    }

    & (Join-Path $resolvedTempRoot "install.ps1") `
        -ExtensionId ("a" * 32) `
        -PythonExe $pythonExe `
        -SkipRegistry

    if (Test-Path -LiteralPath (Join-Path $resolvedTempRoot "vault-path.txt")) {
        throw "Omitting -VaultPath must restore the default vault layout."
    }
    $manifest = Get-Content -LiteralPath (Join-Path $resolvedTempRoot "native-host-manifest.json") -Raw | ConvertFrom-Json
    if ($manifest.allowed_origins -notcontains ("chrome-extension://" + ("a" * 32) + "/")) {
        throw "The generated manifest does not authorize the requested extension."
    }
    Write-Host "Install script behavior verified."
} finally {
    $resolvedTempRoot = [System.IO.Path]::GetFullPath($resolvedTempRoot)
    if ($resolvedTempRoot.StartsWith([System.IO.Path]::GetTempPath(), [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
    }
}
