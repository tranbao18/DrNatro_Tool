@echo off
REM Chay tool mot lan, ghi log vao logs\scheduler.log. Dung cho Windows Task Scheduler.
cd /d "%~dp0.."
if not exist logs mkdir logs
call npm start >> logs\scheduler.log 2>&1
