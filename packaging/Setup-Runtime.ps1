param([switch]$DownloadStarterModels)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$python = Join-Path $PSScriptRoot '.genai-venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $python)) {
    & python -m venv .genai-venv
    if ($LASTEXITCODE -ne 0) { throw 'Install 64-bit Python and make it available on PATH.' }
}

& $python -m pip install openvino-genai==2026.4.1.0 huggingface_hub pillow
if ($LASTEXITCODE -ne 0) { throw 'Could not install the local inference runtime.' }

if ($DownloadStarterModels) {
    & $python -c "from huggingface_hub import snapshot_download; snapshot_download('OpenVINO/Qwen2-0.5B-Instruct-int4-ov', local_dir='models/chat', ignore_patterns=['*checkpoint*']); snapshot_download('OpenVINO/stable-diffusion-v1-5-int8-ov', local_dir='models/image')"
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the starter models.' }
}
Write-Host 'Runtime ready. Open Start-RenderLedger.cmd.'
