@echo off
chcp 65001 > nul
echo.
echo  Boitube - Khoi dong server...
echo.

cd /d "%~dp0server"

if not exist node_modules (
  echo  Dang cai dependencies...
  npm install
  echo.
)

node index.js
pause
