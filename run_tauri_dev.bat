@echo off
rem 临时脚本：优先使用 PATH 中的 npm，找不到才尝试常见安装目录
where npm >nul 2>&1
if %errorlevel% equ 0 (
    cd /d "%~dp0"
    npm run tauri -- dev
    exit /b
)
if exist "D:\Program Files\nodejs\npm.cmd" (
    set PATH=D:\Program Files\nodejs;%PATH%
    cd /d "%~dp0"
    npm run tauri -- dev
    exit /b
)
if exist "%APPDATA%\npm\npm.cmd" (
    set PATH=%APPDATA%\npm;%PATH%
    cd /d "%~dp0"
    npm run tauri -- dev
    exit /b
)
echo [ERROR] 未找到 npm，请安装 Node.js 并确保其在 PATH 中。
pause
