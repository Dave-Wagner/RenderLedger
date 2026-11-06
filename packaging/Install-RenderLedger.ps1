param([switch]$SkipLaunch, [switch]$SkipShortcut)
$ErrorActionPreference = 'Stop'
try {
    $destination = Join-Path $env:LOCALAPPDATA 'RenderLedger'
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    foreach ($name in @('renderledger.exe', 'Start-RenderLedger.cmd', 'Setup-Runtime.ps1', 'Set-Up-Cloud-Tools.cmd', 'README.txt', 'LICENSE', '.env.example')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $destination -Force
    }
    $settings = Join-Path $destination '.env'
    if (!(Test-Path -LiteralPath $settings)) {
        Copy-Item -LiteralPath (Join-Path $destination '.env.example') -Destination $settings
    }
    $launcher = Join-Path $destination 'Start-RenderLedger.cmd'
    if (!$SkipShortcut) {
        $programs = [Environment]::GetFolderPath('Programs')
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path $programs 'RenderLedger.lnk'))
        $shortcut.TargetPath = $env:ComSpec
        $shortcut.Arguments = '/d /c ""' + $launcher + '""'
        $shortcut.WorkingDirectory = $destination
        $shortcut.IconLocation = (Join-Path $destination 'renderledger.exe') + ',0'
        $shortcut.Save()
    }
    Write-Host "RenderLedger installed at $destination."
    if (!$SkipLaunch) { Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /c ""' + $launcher + '""') -WindowStyle Normal }
} catch {
    Write-Error -ErrorAction Continue $_
    exit 1
}
