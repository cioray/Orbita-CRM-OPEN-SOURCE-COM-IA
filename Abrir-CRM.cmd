@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Abrir-CRM.ps1"
if errorlevel 1 pause
