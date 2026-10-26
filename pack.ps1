# Builds dist\SMB_Transaction_Tracker.zip for "Hosting: Zoho" upload.
# ZIP root = contents of app\ + plugin-manifest.json  ->  Index Page: /index.html
# (dev\ is local-preview only and is NOT packaged.)

$ErrorActionPreference = "Stop"
$root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist  = Join-Path $root "dist"
$stage = Join-Path $dist "_stage"
$zip   = Join-Path $dist "SMB_Transaction_Tracker.zip"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

Copy-Item (Join-Path $root "app\*") $stage -Recurse
Copy-Item (Join-Path $root "plugin-manifest.json") $stage

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
Remove-Item $stage -Recurse -Force

Write-Host "Created $zip"
