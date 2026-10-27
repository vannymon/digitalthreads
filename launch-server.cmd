@echo off
REM Serves the production build at http://localhost:3000.
REM Invoked by the "Digital Threads server" scheduled task at logon.
cd /d "%~dp0"
if not exist "%LOCALAPPDATA%\digitalthreads" mkdir "%LOCALAPPDATA%\digitalthreads"
node "%~dp0node_modules\next\dist\bin\next" start -p 3000 >> "%LOCALAPPDATA%\digitalthreads\server.log" 2>&1
