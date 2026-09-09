@echo off
REM ===========================================================================
REM EDIMS - setup-local.bat  (Windows convenience launcher)
REM Runs setup-local.ps1 with the execution policy bypassed for this one
REM process only (does not change any system setting). Pass-through any flags,
REM e.g.:  setup-local.bat -Reset
REM ===========================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-local.ps1" %*
