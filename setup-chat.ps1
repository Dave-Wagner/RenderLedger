$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$python = "$env:USERPROFILE/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
if (!(Test-Path -LiteralPath $python)) {
    $python = (Get-Command python -ErrorAction Stop).Source
}

$downloader = Join-Path $PSScriptRoot '.runtime/chat-download'
& $python -m pip --disable-pip-version-check install --target $downloader huggingface_hub
if ($LASTEXITCODE -ne 0) { throw 'Could not install the checkpoint downloader.' }

$previousPythonPath = $env:PYTHONPATH
try {
    $env:PYTHONPATH = $downloader
    & $python -c "from huggingface_hub import snapshot_download; snapshot_download('OpenVINO/Qwen2.5-7B-Instruct-int4-ov', local_dir='models/chat-qwen25-7b', token=False)"
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the Qwen2.5 checkpoint.' }
} finally {
    $env:PYTHONPATH = $previousPythonPath
}

Write-Host 'Qwen2.5 7B installed. Refresh the rebuilt RenderLedger dashboard and open Chat rooms.'
