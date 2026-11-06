$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$template = Join-Path $root '.env.example'
$pattern = '\b(?:NPU_LAB_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_API_KEY(?:_DEV_READONLY)?|ELEVENLABS_DEV_KEY)\b'
$source = Get-ChildItem (Join-Path $root 'src') -File | Where-Object Extension -in '.rs', '.py'
$expected = @($source | ForEach-Object {
    [regex]::Matches((Get-Content -LiteralPath $_.FullName -Raw), $pattern).Value
} | Sort-Object -Unique)
$defined = @{}
foreach ($line in Get-Content -LiteralPath $template) {
    if ($line -match '^\s*(?:#\s*)?([A-Z][A-Z0-9_]+)=(.*)$') {
        $name = $Matches[1]
        $value = $Matches[2].Trim()
        if ($defined.ContainsKey($name)) { throw "Duplicate .env.example entry: $name" }
        if ($name -match 'KEY|TOKEN|SECRET|PASSWORD' -and $value) {
            throw "Credential placeholder must be blank: $name"
        }
        $defined[$name] = $true
    }
}
$missing = @($expected | Where-Object { !$defined.ContainsKey($_) })
if ($missing.Count) { throw "Missing from .env.example: $($missing -join ', ')" }
Write-Host "Checked $($expected.Count) environment options."
