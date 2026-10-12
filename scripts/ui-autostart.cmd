@echo off
REM Chay giao dien quan ly an (khong cua so), duoc Task Scheduler goi khi dang nhap Windows.
REM Nhat ky khoi dong (ke ca loi cau hinh) ghi vao logs\ui-autostart.log.
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Khoi dong giao dien >> logs\ui-autostart.log
node src\index.js ui --no-open >> logs\ui-autostart.log 2>&1
