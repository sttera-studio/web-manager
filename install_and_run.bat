@echo off
cd /d "%~dp0web-manager-node"

if not exist "package.json" (
    echo Initializing npm project
    npm init -y
)

if not exist "node_modules\ws" (
    echo Installing dependencies
    npm install ws
)

set CHROME_PATH=
for %%P in (
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
    if exist %%P (
        set CHROME_PATH=%%P
        goto :found_chrome
    )
)

:found_chrome
if defined CHROME_PATH (
    start "" /b cmd /c "timeout /t 2 /nobreak >nul && start """" %CHROME_PATH% http://127.0.0.1:3000"
) else (
    start "" /b cmd /c "timeout /t 2 /nobreak >nul && start """" http://127.0.0.1:3000"
)

echo Starting server... Press Ctrl+C to stop.
node server.js
