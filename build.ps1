<#
.SYNOPSIS
  Builds the self-contained Autoconfig script and an optional release zip.

.DESCRIPTION
  The installer builds firefox-native-tab-search.cfg from src/core.js and
  src/native-tab-search.js. This script produces the same file in dist/ for
  manual inspection or manual installation, and can package a release zip.

.PARAMETER Release
  Also create dist/firefox-native-tab-search-<version>.zip with the installer,
  uninstaller and sources.

.EXAMPLE
  .\build.ps1
  .\build.ps1 -Release
#>
param(
  [switch]$Release
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$src = Join-Path $root "src"
$dist = Join-Path $root "dist"
$corePath = Join-Path $src "core.js"
$uiPath = Join-Path $src "native-tab-search.js"
$prefsPath = Join-Path $src "autoconfig-prefs.js"
$entryPath = Join-Path $src "entry.js"

foreach ($path in @($corePath, $uiPath, $prefsPath, $entryPath)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing source file: $path"
  }
}

New-Item -ItemType Directory -Path $dist -Force | Out-Null

$core = [System.IO.File]::ReadAllText($corePath)
$ui = [System.IO.File]::ReadAllText($uiPath)
$entry = [System.IO.File]::ReadAllText($entryPath)
# Firefox Autoconfig skips the first line of the file. Keep a harmless header
# comment there so the real script starts on line 2.
$header = "// Firefox Native Tab Search - Autoconfig loader. Generated file; do not edit.`r`n"
$cfg = $header + $core + "`r`n`r`n" + $ui + "`r`n`r`n" + $entry

$cfgPath = Join-Path $dist "firefox-native-tab-search.cfg"
$prefPath = Join-Path $dist "zz-firefox-native-tab-search.js"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($cfgPath, $cfg, $utf8NoBom)
[System.IO.File]::WriteAllText($prefPath, [System.IO.File]::ReadAllText($prefsPath), $utf8NoBom)

Write-Host "Built: $cfgPath"
Write-Host "Built: $prefPath"

if (Get-Command node -ErrorAction SilentlyContinue) {
  $checkPath = Join-Path $env:TEMP ("fnts-check-" + [guid]::NewGuid().ToString("N") + ".js")
  Copy-Item -LiteralPath $cfgPath -Destination $checkPath
  try {
    & node --check $checkPath
    if ($LASTEXITCODE -ne 0) {
      throw "The generated Autoconfig script failed the JavaScript syntax check."
    }
    Write-Host "Syntax check: OK"
  } finally {
    Remove-Item -LiteralPath $checkPath -Force -ErrorAction SilentlyContinue
  }
}

if ($Release) {
  $package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
  $version = $package.version
  $staging = Join-Path $dist "release"
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
  New-Item -ItemType Directory -Path $staging -Force | Out-Null

  foreach ($name in @("install.cmd", "install.ps1", "uninstall.cmd", "uninstall.ps1", "README.md", "LICENSE", "NOTICE", "package.json", "build.ps1")) {
    $source = Join-Path $root $name
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination $staging -Force
    }
  }
  Copy-Item -LiteralPath $src -Destination (Join-Path $staging "src") -Recurse -Force
  $docs = Join-Path $root "docs"
  if (Test-Path -LiteralPath $docs) {
    Copy-Item -LiteralPath $docs -Destination (Join-Path $staging "docs") -Recurse -Force
  }

  $zipPath = Join-Path $dist "firefox-native-tab-search-$version.zip"
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force
  Write-Host "Package: $zipPath"
}
