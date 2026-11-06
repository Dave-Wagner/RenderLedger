RenderLedger for Windows

1. Extract the entire ZIP.
2. Double-click Install-RenderLedger.cmd to install and open the dashboard.
3. Next time, search the Start menu for RenderLedger.
4. Keep the console open. Before closing it, stop active workloads and wait
   for any Runpod cleanup confirmation.

The dashboard needs no compiler, Python, model download, or API key.
For cloud tools, double-click Set-Up-Cloud-Tools.cmd after installation.
It installs Python through WinGet if necessary. Add your own keys to
%LOCALAPPDATA%\RenderLedger\.env and restart RenderLedger.

Windows ARM64 runs the dashboard natively on Snapdragon. This setup does
not provision Snapdragon NPU, OpenVINO, or CUDA inference.
This build is unsigned. Windows may show an unknown publisher warning.
