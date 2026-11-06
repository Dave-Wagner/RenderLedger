$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$nvidiaSmi = (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue).Source
if (!$nvidiaSmi) {
    $nvidiaSmi = @(
        "$env:WINDIR/System32/nvidia-smi.exe"
        "$env:ProgramFiles/NVIDIA Corporation/NVSMI/nvidia-smi.exe"
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (!$nvidiaSmi) {
    [Console]::Error.WriteLine('Wan setup stopped before downloading anything. This video backend requires an NVIDIA CUDA GPU and driver. Intel graphics cannot run this backend.')
    exit 1
}
& $nvidiaSmi --list-gpus
if ($LASTEXITCODE -ne 0) { throw 'The NVIDIA driver could not find a usable GPU.' }

$bootstrapPython = "$env:USERPROFILE/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
if (!(Test-Path -LiteralPath $bootstrapPython)) {
    $bootstrapPython = (Get-Command python -ErrorAction Stop).Source
}
$videoPython = Join-Path $PSScriptRoot '.runtime/wan-venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $videoPython)) {
    & $bootstrapPython -m venv .runtime/wan-venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Wan Python environment.' }
}

& $videoPython -m pip install --index-url https://download.pytorch.org/whl/cu128 torch
if ($LASTEXITCODE -ne 0) { throw 'Could not install CUDA PyTorch.' }
& $videoPython -c "import torch; assert torch.cuda.is_available(), 'CUDA is unavailable. Check the NVIDIA driver.'; print(torch.empty(1, device='cuda').device)"
if ($LASTEXITCODE -ne 0) { throw 'CUDA verification failed before downloading the checkpoint.' }
& $videoPython -m pip install 'diffusers>=0.35,<1' 'transformers>=4.57,<5' accelerate sentencepiece 'imageio[ffmpeg]'
if ($LASTEXITCODE -ne 0) { throw 'Could not install Wan dependencies.' }
& $videoPython -c "from diffusers import WanPipeline; from huggingface_hub import snapshot_download; snapshot_download('Wan-AI/Wan2.1-T2V-1.3B-Diffusers', local_dir='models/wan2.1-t2v-1.3b', ignore_patterns=['*.bin', '*.pth', '*.mp4', '*.gif']); WanPipeline.load_config('models/wan2.1-t2v-1.3b', local_files_only=True)"
if ($LASTEXITCODE -ne 0) { throw 'Could not download or verify the Wan checkpoint.' }

& cargo build --release
if ($LASTEXITCODE -ne 0) { throw 'Wan is installed, but the RenderLedger build failed.' }
Write-Host 'Wan setup complete. Restart RenderLedger using target/release/renderledger.exe and select Wan in Media Studio.'
