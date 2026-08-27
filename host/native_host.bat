@echo off
set "PYTHON_EXE=D:\anaconda\envs\learn-claude-code\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"
"%PYTHON_EXE%" -B "%~dp0native_host.py"
