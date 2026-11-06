param(
    [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
    [string]$CertificateThumbprint,
    [string]$SignTool = 'signtool.exe',
    [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& (Join-Path $PSScriptRoot 'scripts/check-env.ps1')
$targetDir = Join-Path $PSScriptRoot 'target/distribution'
$triple = @{x64 = 'x86_64-pc-windows-msvc'; arm64 = 'aarch64-pc-windows-msvc'}[$Architecture]
& rustup target add $triple
if ($LASTEXITCODE -ne 0) { throw "Could not install the Rust target $triple." }
# Link the Microsoft C runtime into the executable to simplify installation.
$flagsKey = 'CARGO_TARGET_' + $triple.ToUpperInvariant().Replace('-', '_') + '_RUSTFLAGS'
$previousFlags = [Environment]::GetEnvironmentVariable($flagsKey, 'Process')
try {
    [Environment]::SetEnvironmentVariable($flagsKey, ("$previousFlags -C target-feature=+crt-static").Trim(), 'Process')
    & cargo build --release --locked --target $triple --target-dir $targetDir
} finally {
    [Environment]::SetEnvironmentVariable($flagsKey, $previousFlags, 'Process')
}
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

foreach ($file in @('Start-RenderLedger.cmd', 'Setup-Runtime.ps1', 'Set-Up-Cloud-Tools.cmd', 'Install-RenderLedger.cmd', 'Install-RenderLedger.ps1', 'README.txt')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "packaging/$file") -Destination $stage
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LICENSE') -Destination $stage

$archive = Join-Path $dist "RenderLedger-windows-$Architecture-$variant.zip"
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '.env.example') -Destination $stage
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $archive)
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    if (!$zip.GetEntry('.env.example')) { throw 'Package is missing .env.example.' }
} finally { $zip.Dispose() }

$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$archive.sha256" -Value "$hash  $(Split-Path -Leaf $archive)" -Encoding ascii
Write-Host "Package: $archive"
Write-Host "SHA-256: $hash"
