$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$bootstrapPython = "$env:USERPROFILE/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
if (!(Test-Path -LiteralPath $bootstrapPython)) {
    $bootstrapPython = (Get-Command python -ErrorAction Stop).Source
}

$musicPython = Join-Path $PSScriptRoot '.runtime/musicgen-venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $musicPython)) {
    & $bootstrapPython -m venv .runtime/musicgen-venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the MusicGen Python environment.' }
}

& $musicPython -m pip install --index-url https://download.pytorch.org/whl/cpu torch
if ($LASTEXITCODE -ne 0) { throw 'Could not install CPU PyTorch.' }
& $musicPython -m pip install 'transformers>=4.57,<5' sentencepiece
if ($LASTEXITCODE -ne 0) { throw 'Could not install MusicGen dependencies.' }

& $musicPython -c "from transformers import AutoProcessor, MusicgenForConditionalGeneration; from huggingface_hub import snapshot_download; snapshot_download('facebook/musicgen-small', local_dir='models/musicgen-small', ignore_patterns=['*.bin', '*.h5', '*.msgpack']); AutoProcessor.from_pretrained('models/musicgen-small', local_files_only=True)"
if ($LASTEXITCODE -ne 0) { throw 'Could not download or verify MusicGen Small.' }
if (!(Test-Path -LiteralPath 'models/musicgen-small/model.safetensors')) {
    throw 'The MusicGen weights are missing.'
}

$settingsFile = Join-Path $PSScriptRoot '.env'
$settings = if (Test-Path -LiteralPath $settingsFile) { [IO.File]::ReadAllText($settingsFile) } else { '' }
if ($settings -notmatch '(?m)^\s*NPU_LAB_MUSIC_MODEL\s*=') {
    [IO.File]::AppendAllText($settingsFile, "`r`nNPU_LAB_MUSIC_MODEL=models/musicgen-small`r`n")
}
& cargo build --release
if ($LASTEXITCODE -ne 0) { throw 'MusicGen is installed, but the RenderLedger build failed.' }
Write-Host 'MusicGen setup complete. Restart RenderLedger using target/release/renderledger.exe, then select MusicGen Small in Media Studio.'
