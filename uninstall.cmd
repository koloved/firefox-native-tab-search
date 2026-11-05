@echo off
setlocal
title Firefox Native Tab Search - Uninstaller
echo Firefox Native Tab Search - Uninstaller
echo.
echo This removes the Autoconfig loader from Firefox.
echo Administrator rights are required; Windows will ask for approval.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
if errorlevel 1 (
  echo.
  echo Uninstallation failed.
  pause
)
