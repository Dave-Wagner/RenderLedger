param(
    [string]$CertificateThumbprint,
    [string]$SignTool = 'signtool.exe',
    [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$targetDir = Join-Path $PSScriptRoot 'target/distribution'
$triple = 'x86_64-pc-windows-msvc'
& cargo build --release --locked --target $triple --target-dir $targetDir
if ($LASTEXITCODE -ne 0) { throw 'RenderLedger build failed.' }

$dist = Join-Path $targetDir 'packages'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$stage = Join-Path $dist ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$exe = Join-Path $stage 'renderledger.exe'
Copy-Item -LiteralPath (Join-Path $targetDir "$triple/release/renderledger.exe") -Destination $exe

$variant = 'unsigned'
if ($CertificateThumbprint) {
    & $SignTool sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $exe
    if ($LASTEXITCODE -ne 0) { throw 'Authenticode signing failed.' }
    & $SignTool verify /pa $exe
    if ($LASTEXITCODE -ne 0) { throw 'Authenticode verification failed.' }
    $variant = 'signed'
}

foreach ($file in @('Start-RenderLedger.cmd', 'Setup-Runtime.ps1', 'README.txt')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "packaging/$file") -Destination $stage
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LICENSE') -Destination $stage

$archive = Join-Path $dist "RenderLedger-windows-x64-$variant.zip"
Compress-Archive -LiteralPath @(
    $exe,
    (Join-Path $stage 'Start-RenderLedger.cmd'),
    (Join-Path $stage 'Setup-Runtime.ps1'),
    (Join-Path $stage 'README.txt'),
    (Join-Path $stage 'LICENSE')
) -DestinationPath $archive -Force
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$archive.sha256" -Value "$hash  $(Split-Path -Leaf $archive)" -Encoding ascii
Write-Host "Package: $archive"
Write-Host "SHA-256: $hash"
