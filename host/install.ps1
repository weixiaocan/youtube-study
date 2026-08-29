param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[a-p]{32}$")]
    [string]$ExtensionId,
    [string]$PythonExe = "",
    [string]$VaultPath = "",
    [switch]$SkipRegistry
)

$ErrorActionPreference = "Stop"

$hostDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcherPath = (Resolve-Path (Join-Path $hostDir "native_host.bat")).Path
$manifestPath = Join-Path $hostDir "native-host-manifest.json"
$pythonPathFile = Join-Path $hostDir "python-path.txt"
$vaultPathFile = Join-Path $hostDir "vault-path.txt"
$hostName = "com.lianqian.youtube_study"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if ($PythonExe) {
    $resolvedPython = (Resolve-Path -LiteralPath $PythonExe).Path
} elseif (Test-Path -LiteralPath $pythonPathFile) {
    $configuredPython = [System.IO.File]::ReadAllText($pythonPathFile).Trim()
    $resolvedPython = (Resolve-Path -LiteralPath $configuredPython).Path
} else {
    $resolvedPython = (Get-Command python -ErrorAction Stop).Source
}

$pythonCheckOutput = & $resolvedPython -c "import json, pathlib, socket, subprocess, urllib.request" 2>&1
if ($LASTEXITCODE -ne 0) {
    $details = ($pythonCheckOutput | Out-String).Trim()
    throw "Python cannot run the native host dependencies: $resolvedPython. Install a complete Python 3 runtime or pass -PythonExe with its full path. $details"
}
[System.IO.File]::WriteAllText($pythonPathFile, $resolvedPython, $utf8NoBom)

if ($VaultPath) {
    $resolvedVault = (Resolve-Path -LiteralPath $VaultPath).Path
    [System.IO.File]::WriteAllText($vaultPathFile, $resolvedVault, $utf8NoBom)
} elseif (Test-Path -LiteralPath $vaultPathFile) {
    Remove-Item -LiteralPath $vaultPathFile -Force
}

$manifest = [ordered]@{
    name = $hostName
    description = "YouTube Study local workspace bridge"
    path = $launcherPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8NoBom)

$registryTargets = @(
    "HKCU\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)
if (-not $SkipRegistry) {
    foreach ($target in $registryTargets) {
        & reg.exe add $target /ve /t REG_SZ /d $manifestPath /f | Out-Null
    }
}

Write-Host "YouTube Study native host installed."
Write-Host "Manifest: $manifestPath"
Write-Host "Allowed extension: $ExtensionId"
Write-Host "Python: $([System.IO.File]::ReadAllText($pythonPathFile))"
if (Test-Path -LiteralPath $vaultPathFile) {
    Write-Host "Vault: $([System.IO.File]::ReadAllText($vaultPathFile))"
} else {
    Write-Host "Vault: default layout (<vault>/.claudian/tools/youtube-study), pass -VaultPath to override"
}
