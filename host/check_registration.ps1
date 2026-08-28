param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[a-p]{32}$")]
    [string]$ExtensionId,

    [ValidateSet("Chrome", "Edge")]
    [string]$Browser = "Chrome"
)

$ErrorActionPreference = "Stop"

$hostName = "com.lianqian.youtube_study"
$manifestPath = Join-Path $PSScriptRoot "native-host-manifest.json"
$registryPath = if ($Browser -eq "Edge") {
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
} else {
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
}

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Native Messaging manifest is missing: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$expectedOrigin = "chrome-extension://$ExtensionId/"
if ($expectedOrigin -notin @($manifest.allowed_origins)) {
    $allowed = @($manifest.allowed_origins) -join ", "
    throw "Native Messaging origin mismatch. Current extension requires '$expectedOrigin', manifest allows '$allowed'."
}

if (-not (Test-Path -LiteralPath $registryPath)) {
    throw "$Browser Native Messaging registration is missing: $registryPath"
}

$registeredManifest = (Get-Item -LiteralPath $registryPath).GetValue("")
if ([string]::IsNullOrWhiteSpace($registeredManifest)) {
    throw "$Browser Native Messaging registration has no manifest path."
}

if ((Resolve-Path -LiteralPath $registeredManifest).Path -ne (Resolve-Path -LiteralPath $manifestPath).Path) {
    throw "$Browser is registered to a different manifest: $registeredManifest"
}

if (-not (Test-Path -LiteralPath $manifest.path)) {
    throw "Native host launcher is missing: $($manifest.path)"
}

Write-Host "Native Messaging registration is valid."
Write-Host "Browser: $Browser"
Write-Host "Extension: $ExtensionId"
Write-Host "Manifest: $manifestPath"
Write-Host "Launcher: $($manifest.path)"
