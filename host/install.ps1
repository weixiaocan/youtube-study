param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[a-p]{32}$")]
    [string]$ExtensionId,
    [string]$PythonExe = ""
)

$ErrorActionPreference = "Stop"

$hostDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcherPath = (Resolve-Path (Join-Path $hostDir "native_host.bat")).Path
$manifestPath = Join-Path $hostDir "native-host-manifest.json"
$pythonPathFile = Join-Path $hostDir "python-path.txt"
$hostName = "com.lianqian.youtube_study"

if ($PythonExe) {
    $resolvedPython = (Resolve-Path -LiteralPath $PythonExe).Path
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($pythonPathFile, $resolvedPython, $utf8NoBom)
} elseif (-not (Test-Path -LiteralPath $pythonPathFile)) {
    $detectedPython = (Get-Command python -ErrorAction Stop).Source
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($pythonPathFile, $detectedPython, $utf8NoBom)
}

$manifest = [ordered]@{
    name = $hostName
    description = "YouTube Study local workspace bridge"
    path = $launcherPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8NoBom)

$registryTargets = @(
    "HKCU\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)
foreach ($target in $registryTargets) {
    & reg.exe add $target /ve /t REG_SZ /d $manifestPath /f | Out-Null
}

Write-Host "YouTube Study native host installed."
Write-Host "Manifest: $manifestPath"
Write-Host "Allowed extension: $ExtensionId"
Write-Host "Python: $([System.IO.File]::ReadAllText($pythonPathFile))"
