@echo off
rem ---------------------------------------------------------------------------
rem  ModuScene - Windows development launcher
rem
rem  Double-click this file to install missing dependencies and start the Vite
rem  development server. Everything runs from THIS FILE'S OWN FOLDER, so the
rem  project can be moved, copied or cloned anywhere and the launcher still
rem  works. No absolute paths are used.
rem
rem  Requires Node.js (npm is bundled with it): https://nodejs.org/
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
title ModuScene - development server

rem 1. Work from the folder that contains this .bat file, not the caller's cwd.
pushd "%~dp0" 2>nul
if errorlevel 1 goto :no_folder

echo.
echo  ==========================================================
echo   ModuScene - development launcher
echo  ==========================================================
echo   Project folder: %CD%
echo.

rem 2. This must be the real project folder.
if not exist "package.json" goto :no_project

rem 3. Node.js and npm are required.
where node >nul 2>nul
if errorlevel 1 goto :no_node
where npm >nul 2>nul
if errorlevel 1 goto :no_npm

set "NODE_VERSION=unknown"
set "NPM_VERSION=unknown"
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
for /f "delims=" %%v in ('npm --version 2^>nul') do set "NPM_VERSION=%%v"
echo   Node.js %NODE_VERSION%   npm %NPM_VERSION%
echo.

rem 4. Install dependencies only when they are actually missing.
if exist "node_modules\" goto :deps_ok
if not exist "package-lock.json" goto :install_fallback

echo   Dependencies are not installed - running "npm ci" ...
echo.
call npm ci
if errorlevel 1 goto :install_failed
echo.
echo   Dependencies installed.
echo.
goto :deps_ok

:install_fallback
echo   Dependencies are not installed and package-lock.json is missing.
echo   Falling back to "npm install" ...
echo.
call npm install
if errorlevel 1 goto :install_failed
echo.
echo   Dependencies installed.
echo.
goto :deps_ok

:deps_ok
rem 5. Start the project's existing dev script and open the browser for the user.
echo   Starting the Vite development server...
echo.
echo   Local URL:     http://localhost:3000
echo   Vite prints the exact URL on the next lines. If port 3000 is
echo   already busy, Vite picks the next free port and says so there.
echo.
echo   The browser opens automatically once the server is ready.
echo   Press Ctrl+C in this window to stop the server.
echo.
echo  ----------------------------------------------------------
echo.
call npm run dev -- --open
set "DEV_EXIT=%ERRORLEVEL%"
echo.
echo  ----------------------------------------------------------
echo.
if not "%DEV_EXIT%"=="0" goto :dev_stopped

echo   Development server stopped. Nothing is running any more.
popd
endlocal & exit /b 0

rem ---------------------------------------------------------------------------
rem  Error handling - every failure path ends in :hold so the message stays
rem  readable instead of the window vanishing.
rem ---------------------------------------------------------------------------

:dev_stopped
echo   The development server stopped, exit code %DEV_EXIT%.
echo   If you pressed Ctrl+C, that is expected - nothing is running now.
echo   Otherwise scroll up to the error Vite printed above.
goto :hold

:no_folder
echo.
echo  [ERROR] Could not open the folder that contains this file.
echo          Move Start-ModuScene.bat back into the ModuScene project folder
echo          and double-click it again.
goto :hold

:no_project
echo.
echo  [ERROR] package.json was not found in this folder:
echo            %CD%
echo.
echo          Start-ModuScene.bat must sit in the ModuScene project root,
echo          next to package.json, README.md and vite.config.ts.
echo          If you moved the file, put it back - or run it from a full
echo          copy or clone of the project.
goto :hold

:no_node
echo.
echo  [ERROR] Node.js was not found on this computer.
echo.
echo          ModuScene is built and served by Node.js 18 or newer, which
echo          includes npm. Neither was found on your PATH.
echo.
echo          Fix it in two steps:
echo            1. Install the LTS version from https://nodejs.org/
echo            2. Close this window, then double-click this file again.
echo          A freshly installed Node.js only becomes visible to windows
echo          opened after the installation.
goto :hold

:no_npm
echo.
echo  [ERROR] Node.js was found, but npm was not.
echo.
echo          npm normally ships with Node.js, so this usually means a
echo          broken or partial installation.
echo.
echo          Fix it by reinstalling the LTS version from:
echo            https://nodejs.org/
echo          Then double-click this file again.
goto :hold

:install_failed
echo.
echo  [ERROR] Installing dependencies failed, exit code %ERRORLEVEL%.
echo.
echo          The npm messages above say what went wrong. Common causes:
echo            - no internet connection, or a proxy/firewall blocking npm
echo            - a Node.js version too old for this project
echo            - a half-deleted node_modules folder from an earlier run
echo          Fix the cause, then double-click this file again.
goto :hold

:hold
echo.
echo   Press any key to close this window.
pause >nul
exit /b 1
