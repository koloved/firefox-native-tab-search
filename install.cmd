@echo off
setlocal
title Firefox Native Tab Search - Installer
echo Firefox Native Tab Search
echo.
echo This installs a privileged Autoconfig script into Firefox.
echo Administrator rights are required; Windows will ask for approval.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Installation failed.
  pause
)
