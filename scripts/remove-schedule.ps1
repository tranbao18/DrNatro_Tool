# Gỡ tác vụ Windows Task Scheduler do setup-schedule.ps1 tạo.
$taskName = 'DrNatro Minigame Tool'
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Đã gỡ tác vụ '$taskName' (nếu có)."
