param([Parameter(Mandatory)][ValidateSet('arm64', 'x64')][string]$Architecture)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$zip = Join-Path $root "target/distribution/packages/RenderLedger-windows-$Architecture-unsigned.zip"
$expected = ((Get-Content -LiteralPath "$zip.sha256" -Raw) -split '\s+')[0]
if ((Get-FileHash -LiteralPath $zip).Hash -ne $expected) { throw 'Package checksum mismatch.' }
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ("RenderLedger-" + [guid]::NewGuid())
$files = Join-Path $sandbox 'extracted'
Expand-Archive -LiteralPath $zip -DestinationPath $files
$actual = @(Get-ChildItem -LiteralPath $files -Force | ForEach-Object Name | Sort-Object)
$allowlist = @('.env.example', 'Install-RenderLedger.cmd', 'Install-RenderLedger.ps1', 'LICENSE', 'README.txt', 'renderledger.exe', 'Set-Up-Cloud-Tools.cmd', 'Setup-Runtime.ps1', 'Start-RenderLedger.cmd')
if (Compare-Object $allowlist $actual) { throw 'Package contents do not match the allowlist.' }
$bytes = [IO.File]::ReadAllBytes((Join-Path $files 'renderledger.exe'))
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
if ([BitConverter]::ToUInt16($bytes, $peOffset + 4) -ne @{arm64 = 0xaa64; x64 = 0x8664}[$Architecture]) {
    throw 'Incorrect executable architecture.'
}
$previousLocalAppData = $env:LOCALAPPDATA
$server = $null
try {
    $env:LOCALAPPDATA = $sandbox
    & (Join-Path $files 'Install-RenderLedger.ps1') -SkipLaunch -SkipShortcut
    $installed = Join-Path $sandbox 'RenderLedger'
    $settings = Join-Path $installed '.env'
    if (!(Test-Path -LiteralPath $settings)) { throw 'Installer did not create .env.' }
    Add-Content -LiteralPath $settings '# preserve this user setting'
    & (Join-Path $files 'Install-RenderLedger.ps1') -SkipLaunch -SkipShortcut
    if (!(Select-String -LiteralPath $settings -Pattern 'preserve this user setting' -Quiet)) {
        throw 'Update overwrote .env.'
    }
    $exe = Join-Path $installed 'renderledger.exe'
    & $exe --help
    if ($LASTEXITCODE -ne 0) { throw 'CLI smoke test failed.' }
    $server = Start-Process -FilePath $exe -ArgumentList 'gui', '18765' -WorkingDirectory $installed -WindowStyle Hidden -PassThru
    $response = $null
    for ($i = 0; $i -lt 15; $i++) {
        if ($server.HasExited) { throw 'Dashboard exited unexpectedly.' }
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:18765/' -TimeoutSec 2
            break
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (!$response -or $response.Content -notmatch '<title>RenderLedger</title>') { throw 'Dashboard smoke test failed.' }
    $history = Invoke-WebRequest -Uri 'http://127.0.0.1:18765/history' -TimeoutSec 2
    if ($history.Content.Trim() -ne '[]') { throw 'Expected an empty history in the isolated install.' }
} finally {
    if ($server -and !$server.HasExited) { Stop-Process -Id $server.Id }
    $env:LOCALAPPDATA = $previousLocalAppData
}
