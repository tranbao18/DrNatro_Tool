# Gỡ chế độ tự bật giao diện cùng Windows và tắt giao diện đang chạy ẩn.
# Chạy:  powershell -ExecutionPolicy Bypass -File .\scripts\remove-ui-autostart.ps1
$taskName = 'DrNatro Minigame UI'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'src[\\/]index\.js"?\s+ui\s+--no-open' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "Đã gỡ '$taskName' và tắt giao diện chạy ẩn (nếu có)."
