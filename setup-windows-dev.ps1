param([ValidateSet('arm64', 'x64')][string]$Architecture)
$ErrorActionPreference = 'Stop'
if (!$Architecture) {
    $osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    $Architecture = if ($osArch -eq 'Arm64') { 'arm64' } else { 'x64' }
}

function Install-WithWinGet {
    param([string]$Id, [string[]]$Options)
    if (!(Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'Install App Installer from Microsoft Store to enable WinGet, then rerun setup.'
    }
    & winget install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements @Options
    if ($LASTEXITCODE -ne 0) { throw "WinGet could not install $Id (exit $LASTEXITCODE)." }
}

$rustBin = Join-Path $env:USERPROFILE '.cargo/bin'
$env:PATH = "$rustBin;$env:PATH"
if (!(Get-Command rustup -ErrorAction SilentlyContinue)) {
    Install-WithWinGet 'Rustlang.Rustup' @('--architecture', $Architecture)
}
if (!(Get-Command rustup -ErrorAction SilentlyContinue)) {
    throw 'Rustup was installed but is not visible yet. Open a new PowerShell window and rerun setup.'
}

$toolset = if ($Architecture -eq 'arm64') {
    'Microsoft.VisualStudio.Component.VC.Tools.ARM64'
} else {
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = if (Test-Path -LiteralPath $vswhere) {
    & $vswhere -latest -products '*' -requires $toolset -property installationPath
}
if (!$vs) {
    Write-Host 'Installing Microsoft C++ Build Tools and Windows SDK. Windows may ask for administrator approval.'
    $installOptions = "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --add $toolset --includeRecommended"
    Install-WithWinGet 'Microsoft.VisualStudio.2022.BuildTools' @('--override', $installOptions)
}

& (Join-Path $PSScriptRoot 'package-windows.ps1') -Architecture $Architecture
