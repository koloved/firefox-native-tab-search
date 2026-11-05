<#
.SYNOPSIS
  Installs Firefox Native Tab Search into a stable Firefox installation.

.DESCRIPTION
  Copies a privileged Autoconfig loader next to firefox.exe and adds one
  defaults/pref pointer. The loader injects a search field above the native
  vertical tab strip and filters tabs with gBrowser.hideTab()/showTab().
  No extension, XPI, WebExtension API, user preference or profile data is used.

  Administrator rights are required because Firefox is normally installed
  under Program Files.

.PARAMETER FirefoxDir
  Optional Firefox application directory (the folder containing firefox.exe).
  Stable Firefox is detected automatically when omitted.

.PARAMETER Force
  Reinstall even when the same version is already present. A timestamped
  backup of this project's own files is always created before overwriting.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -FirefoxDir "C:\Program Files\Mozilla Firefox"
#>
param(
  [string]$FirefoxDir = "",
  [switch]$Force,
  [switch]$WhatIf,
  [switch]$Elevated
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$scriptPath = $PSCommandPath
if (-not $scriptPath) {
  $scriptPath = $MyInvocation.MyCommand.Path
}
if (-not $scriptDir -and $scriptPath) {
  $scriptDir = Split-Path -Parent $scriptPath
}

function Fail([string]$Message, [int]$Code = 1) {
  Write-Host ""
  Write-Host "ERROR: $Message" -ForegroundColor Red
  if ($Elevated) { Read-Host "Press Enter to close" | Out-Null }
  exit $Code
}

function Test-Administrator() {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Add-Candidate([System.Collections.Generic.List[string]]$List, [string]$Path) {
  if (-not $Path) { return }
  $trimmed = $Path.Trim().Trim('"')
  if ($trimmed -and -not $List.Contains($trimmed)) {
    $List.Add($trimmed)
  }
}

function Find-Firefox([string]$Requested) {
  $candidates = New-Object System.Collections.Generic.List[string]

  if ($Requested) {
    $requestedPath = $Requested.Trim().Trim('"')
    if (Test-Path -LiteralPath $requestedPath -PathType Leaf) {
      $requestedPath = Split-Path -Parent $requestedPath
    }
    Add-Candidate $candidates $requestedPath
  }

  # Registry: stable Firefox (per-machine and per-user).
  $registryRoots = @(
    "HKLM:\SOFTWARE\Mozilla\Mozilla Firefox",
    "HKLM:\SOFTWARE\WOW6432Node\Mozilla\Mozilla Firefox",
    "HKCU:\SOFTWARE\Mozilla\Mozilla Firefox"
  )
  foreach ($root in $registryRoots) {
    try {
      if (-not (Test-Path $root)) { continue }
      $rootProps = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue
      $current = $rootProps.CurrentVersion
      if (-not $current) { continue }
      $mainKey = Join-Path $root "$current\Main"
      if (-not (Test-Path $mainKey)) { continue }
      $mainProps = Get-ItemProperty -Path $mainKey -ErrorAction SilentlyContinue
      if ($mainProps.PathToExe) {
        Add-Candidate $candidates (Split-Path -Parent $mainProps.PathToExe.Trim('"'))
      }
    } catch {
      # Registry entries are optional.
    }
  }

  Add-Candidate $candidates (Join-Path $env:ProgramFiles "Mozilla Firefox")
  if (${env:ProgramFiles(x86)}) {
    Add-Candidate $candidates (Join-Path ${env:ProgramFiles(x86)} "Mozilla Firefox")
  }
  if ($env:LOCALAPPDATA) {
    Add-Candidate $candidates (Join-Path $env:LOCALAPPDATA "Mozilla Firefox")
  }

  foreach ($candidate in $candidates) {
    try {
      $exe = Join-Path $candidate "firefox.exe"
      if (Test-Path -LiteralPath $exe -PathType Leaf) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    } catch {
      # Try the next candidate.
    }
  }
  return $null
}

function Get-FirefoxVersion([string]$Dir) {
  try {
    $raw = (Get-Item -LiteralPath (Join-Path $Dir "firefox.exe")).VersionInfo.ProductVersion
    if ($raw -match '^(\d+(?:\.\d+){0,3})') {
      return [version]$Matches[1]
    }
  } catch {
    return $null
  }
  return $null
}

function Get-FirefoxChannel([string]$Dir) {
  try {
    $prefs = Join-Path $Dir "defaults\pref\channel-prefs.js"
    if (Test-Path -LiteralPath $prefs) {
      $text = Get-Content -LiteralPath $prefs -Raw
      if ($text -match 'app\.update\.channel"\s*,\s*"([^"]+)"') {
        return $Matches[1]
      }
    }
  } catch {
    # Channel detection is best-effort.
  }
  return "unknown"
}

function Test-FirefoxRunning() {
  try {
    return @(Get-Process -Name "firefox" -ErrorAction SilentlyContinue).Count -gt 0
  } catch {
    return $false
  }
}

if (-not (Test-Administrator) -and -not $WhatIf) {
  if (-not $scriptPath) {
    Fail "Administrator rights are required. Run install.cmd or start PowerShell as administrator."
  }
  $elevatedArgs = @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    "`"$scriptPath`""
  )
  if ($FirefoxDir) {
    $elevatedArgs += @('-FirefoxDir', "`"$FirefoxDir`"")
  }
  if ($Force) { $elevatedArgs += '-Force' }
  $elevatedArgs += '-Elevated'
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $elevatedArgs | Out-Null
  } catch {
    Fail "Administrator rights are required. Run install.cmd or start PowerShell as administrator."
  }
  exit 0
}

$sourceCore = Join-Path $scriptDir "src\core.js"
$sourceUi = Join-Path $scriptDir "src\native-tab-search.js"
$sourcePrefs = Join-Path $scriptDir "src\autoconfig-prefs.js"
$sourceEntry = Join-Path $scriptDir "src\entry.js"
foreach ($source in @($sourceCore, $sourceUi, $sourcePrefs, $sourceEntry)) {
  if (-not (Test-Path -LiteralPath $source)) {
    Fail "Missing package file: $source"
  }
}

$FirefoxDir = Find-Firefox $FirefoxDir
if (-not $FirefoxDir) {
  Fail "Could not find stable Firefox. Install it first or pass -FirefoxDir 'C:\Program Files\Mozilla Firefox'."
}

$version = Get-FirefoxVersion $FirefoxDir
$channel = Get-FirefoxChannel $FirefoxDir
Write-Host "Firefox directory: $FirefoxDir"
Write-Host "Firefox version:   $version ($channel)"

if ($version -and $version -lt [version]"140.0") {
  Fail "Firefox $version is too old. Native vertical tabs and this integration require Firefox 140 or newer."
}
if ($channel -ne "release" -and $channel -ne "esr" -and $channel -ne "unknown") {
  Write-Host "Note: this looks like a $channel build. Stable Firefox is recommended." -ForegroundColor Yellow
}

$prefDir = Join-Path $FirefoxDir "defaults\pref"
if (-not (Test-Path -LiteralPath $prefDir)) {
  Fail "Could not find defaults\pref inside the Firefox directory."
}

$cfgName = "firefox-native-tab-search.cfg"
$prefName = "zz-firefox-native-tab-search.js"
$cfgPath = Join-Path $FirefoxDir $cfgName
$prefPath = Join-Path $prefDir $prefName

# Firefox supports only one general.config.filename. Never silently replace
# another Autoconfig or enterprise configuration.
$foreign = @()
Get-ChildItem -LiteralPath $prefDir -Filter "*.js" -File -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Name -eq $prefName) { return }
  try {
    $text = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue
    if ($text -match "general\.config\.filename") {
      $foreign += $_.FullName
    }
  } catch {
    # Unreadable files are not ours to replace.
  }
}
if ($foreign.Count -gt 0) {
  Write-Host ""
  Write-Host "Another Autoconfig setup was found:" -ForegroundColor Yellow
  $foreign | ForEach-Object { Write-Host "  $_" }
  Write-Host ""
  Write-Host "Firefox supports only one general.config.filename." -ForegroundColor Yellow
  Write-Host "This installer will not overwrite it. Merge these lines into the existing config:"
  Write-Host '  pref("general.config.obscure_value", 0);'
  Write-Host '  pref("general.config.filename", "firefox-native-tab-search.cfg");'
  Write-Host "Then copy src\core.js, src\native-tab-search.js and src\autoconfig-prefs.js manually."
  if ($Elevated) { Read-Host "Press Enter to close" | Out-Null }
  exit 2
}

# Build the self-contained Autoconfig script from the two source files.
$core = [System.IO.File]::ReadAllText($sourceCore)
$ui = [System.IO.File]::ReadAllText($sourceUi)
$entry = [System.IO.File]::ReadAllText($sourceEntry)
if ($core -notmatch "FirefoxNativeTabSearchCore" -or $ui -notmatch "FirefoxNativeTabSearch") {
  Fail "The source files do not look like a complete package."
}
$cfg = $core + "`r`n`r`n" + $ui + "`r`n`r`n" + $entry
# Firefox Autoconfig skips the first line of the file. Keep a harmless header
# comment there so the real script starts on line 2.
$header = "// Firefox Native Tab Search - Autoconfig loader. Generated file; do not edit.`r`n"
$cfg = $header + $cfg

$existing = @()
foreach ($target in @($cfgPath, $prefPath)) {
  if (Test-Path -LiteralPath $target) { $existing += $target }
}

if ($WhatIf) {
  Write-Host ""
  Write-Host "Dry run: no files were changed." -ForegroundColor Green
  Write-Host "Would install: $cfgPath"
  Write-Host "Would install: $prefPath"
  if ($existing.Count -gt 0) {
    Write-Host "Existing files would be backed up first."
  }
  exit 0
}

if ($existing.Count -gt 0) {
  $backupDir = Join-Path $FirefoxDir ("firefox-native-tab-search-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  foreach ($target in $existing) {
    $relative = $target.Substring($FirefoxDir.Length).TrimStart('\')
    $destination = Join-Path $backupDir $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $target -Destination $destination -Force
  }
  Write-Host "Backup created:    $backupDir"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($cfgPath, $cfg, $utf8NoBom)
[System.IO.File]::WriteAllText($prefPath, [System.IO.File]::ReadAllText($sourcePrefs), $utf8NoBom)

# Verify the installed files before reporting success.
if (-not (Test-Path -LiteralPath $cfgPath) -or -not (Test-Path -LiteralPath $prefPath)) {
  Fail "Installation verification failed: one or more files are missing."
}
$installedPrefs = Get-Content -LiteralPath $prefPath -Raw
if ($installedPrefs -notmatch [regex]::Escape($cfgName)) {
  Fail "Installation verification failed: the pref file does not point at $cfgName."
}

Write-Host ""
Write-Host "Installed:" -ForegroundColor Green
Write-Host "  $cfgPath"
Write-Host "  $prefPath"
Write-Host ""
if (Test-FirefoxRunning) {
  Write-Host "Firefox is running. Quit every Firefox window before restarting." -ForegroundColor Yellow
  Write-Host ""
}
Write-Host "Next:"
Write-Host "  1. Quit Firefox completely."
Write-Host "  2. Start Firefox again."
Write-Host "  3. The search field appears above the vertical tabs."
Write-Host "  4. Press Ctrl+Alt+F to focus it; Esc clears the filter."
Write-Host ""
Write-Host "Native vertical tabs are enabled by default. If you turned them off,"
Write-Host "enable them in Settings > Appearance (or set sidebar.verticalTabs=true)."
Write-Host ""
Write-Host "To remove the integration, run uninstall.cmd as administrator."
if ($Elevated) { Read-Host "Press Enter to close" | Out-Null }
