@echo off
rem Vultr startup script for Windows instances. Vultr runs these through cmd.exe
rem (not PowerShell, not cloud-init), so this batch stub hands off to the
rem PowerShell bootstrap in the repo. Output lands in C:\slicerlive-bootstrap.log.
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://raw.githubusercontent.com/pieper/SlicerLive/main/desktop/win-bootstrap.ps1 | iex" > C:\slicerlive-bootstrap.log 2>&1
