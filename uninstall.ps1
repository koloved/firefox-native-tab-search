<#
.SYNOPSIS
  Removes Firefox Native Tab Search from a Firefox installation.

.DESCRIPTION
  Deletes the Autoconfig loader, the defaults/pref pointer and any timestamped
  backups created by install.ps1. User preferences and profile data are never
  touched. Administrator rights are required because Firefox is normally
  installed under Program Files.

.PARAMETER FirefoxDir
  Optional Firefox application directory (the folder containing firefox.exe).
  Stable Firefox is detected automatically when omitted.

.EXAMPLE
  .\uninstall.ps1
  .\uninstall.ps1 -FirefoxDir "C:\Program Files\Mozilla Firefox"
#>
param(
  [string]$FirefoxDir = "",
  [switch]$Elevated
)

$ErrorActionPreference = "Stop"

$scriptPath = $PSCommandPath
if (-not $scriptPath) {
  $scriptPath = $MyInvocation.MyCommand.Path
}

function Fail([string]$Message) {
  Write-Host ""
  Write-Host "ERROR: $Message" -ForegroundColor Red
  if ($Elevated) { Read-Host "Press Enter to close" | Out-Null }
  exit 1
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

function Test-FirefoxRunning() {
  try {
    return @(Get-Process -Name "firefox" -ErrorAction SilentlyContinue).Count -gt 0
  } catch {
    return $false
  }
}

if (-not (Test-Administrator)) {
  if (-not $scriptPath) {
    Fail "Administrator rights are required. Run uninstall.cmd or start PowerShell as administrator."
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
  $elevatedArgs += '-Elevated'
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $elevatedArgs | Out-Null
  } catch {
    Fail "Administrator rights are required. Run uninstall.cmd or start PowerShell as administrator."
  }
  exit 0
}

$FirefoxDir = Find-Firefox $FirefoxDir
if (-not $FirefoxDir) {
  Fail "Could not find Firefox. Pass -FirefoxDir 'C:\Program Files\Mozilla Firefox'."
}

Write-Host "Firefox directory: $FirefoxDir"

$cfgPath = Join-Path $FirefoxDir "firefox-native-tab-search.cfg"
$prefPath = Join-Path $FirefoxDir "defaults\pref\zz-firefox-native-tab-search.js"
$removed = 0

foreach ($target in @($cfgPath, $prefPath)) {
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Force
    Write-Host "Removed: $target"
    $removed++
  }
}

Get-ChildItem -LiteralPath $FirefoxDir -Directory -Filter "firefox-native-tab-search-backup-*" -ErrorAction SilentlyContinue |
  ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
    Write-Host "Removed backup: $($_.FullName)"
  }

Write-Host ""
if ($removed -eq 0) {
  Write-Host "Nothing to remove: the integration is not installed in this Firefox." -ForegroundColor Yellow
} else {
  Write-Host "Firefox Native Tab Search removed." -ForegroundColor Green
}
if (Test-FirefoxRunning) {
  Write-Host "Firefox is running. Quit every Firefox window, then start Firefox again." -ForegroundColor Yellow
} else {
  Write-Host "Start Firefox again to restore the original tab strip."
}
Write-Host ""
Write-Host "The sidebar.verticalTabs default is gone. If you enabled it yourself,"
Write-Host "it remains enabled; turn it off in Settings > Appearance if you want."
if ($Elevated) { Read-Host "Press Enter to close" | Out-Null }
