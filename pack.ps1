# Builds dist\SMB_Transaction_Tracker.zip for "Hosting: Zoho" upload.
# ZIP contents: the files of app\ at the root AND again under app/, plus
# plugin-manifest.json  ->  Index Page works as "/index.html" or "/app/index.html".
# (dev\ is local-preview only and is NOT packaged.)

$ErrorActionPreference = "Stop"
$root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$app   = Join-Path $root "app"
$dist  = Join-Path $root "dist"
$zip   = Join-Path $dist "SMB_Transaction_Tracker.zip"

# Stamp a build id into index.html: cache-busts style/config/script for
# browsers and Zoho, and records the build in <meta name="build">.
$build = Get-Date -Format "yyyyMMdd-HHmm"
$indexPath = Join-Path $app "index.html"
$html = [IO.File]::ReadAllText($indexPath)
$html = [regex]::Replace($html, '\?v=[^"]*"', "?v=$build`"")
$html = [regex]::Replace($html, '<meta name="build" content="[^"]*">', "<meta name=`"build`" content=`"$build`">")
[IO.File]::WriteAllText($indexPath, $html, (New-Object System.Text.UTF8Encoding($false)))

# Written with System.IO.Compression so entry names use "/" separators
# (Compress-Archive on Windows PowerShell 5.1 writes "app\file", which
# non-Windows servers do not read as a folder).
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }
$archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem $app -File -Recurse | ForEach-Object {
    $rel = $_.FullName.Substring($app.Length + 1).Replace('\', '/')
    foreach ($name in @($rel, "app/$rel")) {
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  }
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $root "plugin-manifest.json"), "plugin-manifest.json", [IO.Compression.CompressionLevel]::Optimal) | Out-Null
} finally {
  $archive.Dispose()
}

Write-Host "Created $zip"
