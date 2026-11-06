param([switch]$DownloadStarterModels, [switch]$CloudOnly)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arm = $architecture -eq 'ARM64'
if ($arm -and $DownloadStarterModels) {
    throw 'Starter models use OpenVINO. This package does not provision OpenVINO models on Snapdragon.'
}
if ($arm) { $CloudOnly = $true }

$python = Join-Path $PSScriptRoot '.genai-venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $python)) {
    $package = 'Python.Python.3.12'
    $registry = 'HKCU:\Software\Python\PythonCore\3.12\InstallPath'
    $base = if (Test-Path $registry) { (Get-Item $registry).GetValue('ExecutablePath') }
    if (!$base -or !(Test-Path -LiteralPath $base)) {
        if (!(Get-Command winget -ErrorAction SilentlyContinue)) {
            throw 'Install App Installer from Microsoft Store, then rerun this setup.'
        }
        $wingetArch = if ($arm) { 'arm64' } else { 'x64' }
        & winget install --id $package --exact --source winget --architecture $wingetArch --scope user --accept-package-agreements --accept-source-agreements --disable-interactivity
        $base = if (Test-Path $registry) { (Get-Item $registry).GetValue('ExecutablePath') }
        if (!$base -or !(Test-Path -LiteralPath $base)) {
            throw 'Could not find the per-user Python 3.12 installation after running WinGet.'
        }
    }
    & $base -m venv .genai-venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the RenderLedger Python environment.' }
}

if (!$CloudOnly) {
    & $python -m pip install openvino-genai==2026.4.1.0 huggingface_hub pillow
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the local inference runtime.' }
}

if ($DownloadStarterModels) {
    & $python -c "from huggingface_hub import snapshot_download; snapshot_download('OpenVINO/Qwen2-0.5B-Instruct-int4-ov', local_dir='models/chat', ignore_patterns=['*checkpoint*']); snapshot_download('OpenVINO/stable-diffusion-v1-5-int8-ov', local_dir='models/image')"
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the starter models.' }
}
Write-Host 'Runtime ready. Open RenderLedger from the Start menu.'
