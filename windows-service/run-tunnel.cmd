@echo off
"C:\Program Files (x86)\cloudflared\cloudflared.exe" --config "C:\Users\Administrator\.cloudflared\pulse.yml" tunnel run pulse >> "C:\pulse-service\tunnel.log" 2>&1
