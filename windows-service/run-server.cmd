@echo off
cd /d "C:\Users\Administrator\Downloads\pulse-app\pulse-app\server"
"C:\Program Files\nodejs\node.exe" dist/index.js >> "C:\pulse-service\server.log" 2>&1
