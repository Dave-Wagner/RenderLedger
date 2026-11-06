RenderLedger for Windows x64

Extract the entire ZIP into a writable folder. Run Start-RenderLedger.cmd
and open http://127.0.0.1:8765 in your browser. Keep the console open while
a cloud job or Pod cleanup is in progress.

The dashboard and CLI are included. Local inference requires 64-bit Python,
the OpenVINO runtime, compatible hardware drivers, and model checkpoints.
Install the runtime from the extracted folder with:

  powershell -NoProfile -File .\Setup-Runtime.ps1

Add -DownloadStarterModels to install the optional chat and image weights.
Check each model's upstream license before use. To use hosted features,
configure your own provider credentials. Runpod uses RUNPOD_API_KEY and
RUNPOD_API_KEY_DEV_READONLY. ElevenLabs uses ELEVENLABS_DEV_KEY. Add these
to a local .env file or set them in the process environment.

RenderLedger keeps run history in npu-lab.sqlite3 in this folder. Keep your
private datasets, database, and .env out of shared packages.

Windows reputation and organization policies can block unsigned executables.
For a signed build, verify renderledger.exe with Get-AuthenticodeSignature
and follow your organization's software approval process.
