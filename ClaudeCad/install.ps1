# Install ClaudeCad into Fusion 360's AddIns folder.
# No dependencies to install — ClaudeCad talks to the Claude API using only the
# Python standard library.
# Usage (PowerShell, run from inside the ClaudeCad folder):
#   powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = "Stop"

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:APPDATA "Autodesk\Autodesk Fusion 360\API\AddIns\ClaudeCad"

Write-Host "Source:      $src"
Write-Host "Destination: $dest"

if ($src -ne $dest) {
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Get-ChildItem -Path $src -Recurse -File |
        Where-Object { $_.FullName -notmatch "\\\.git\\" -and $_.FullName -notmatch "\\__pycache__\\" } |
        ForEach-Object {
            $rel = $_.FullName.Substring($src.Length).TrimStart('\')
            $target = Join-Path $dest $rel
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            Copy-Item -Path $_.FullName -Destination $target -Force
        }
}

Write-Host ""
Write-Host "Done - no dependencies to install. In Fusion: Utilities > Add-Ins > Scripts and Add-Ins > select 'ClaudeCad' > Run."
Write-Host "Then click the gear icon in the panel and paste your Anthropic API key."
