@echo off
setlocal
set "PYTHON_EXE=python"
if exist "%~dp0python-path.txt" set /p PYTHON_EXE=<"%~dp0python-path.txt"
"%PYTHON_EXE%" -B "%~dp0native_host.py"
