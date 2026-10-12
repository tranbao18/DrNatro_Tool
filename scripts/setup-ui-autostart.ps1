# Cài giao diện quản lý tự bật (chạy ẩn, không cửa sổ) mỗi khi đăng nhập Windows, tự khởi động lại nếu lỗi.
# Chạy:            powershell -ExecutionPolicy Bypass -File .\scripts\setup-ui-autostart.ps1
# Khởi động lại:   powershell -ExecutionPolicy Bypass -File .\scripts\restart-ui.ps1
# Gỡ:              powershell -ExecutionPolicy Bypass -File .\scripts\remove-ui-autostart.ps1
$ErrorActionPreference = 'Stop'
$taskName = 'DrNatro Minigame UI'
$root = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $root 'scripts\ui-autostart.cmd'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Không tìm thấy Node.js trong PATH. Cài Node.js rồi chạy lại.'
}

# conhost --headless chạy chương trình dòng lệnh mà không mở cửa sổ (Windows 10 1809 trở lên).
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless cmd.exe /c `"$runner`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Chờ mạng sẵn sàng sau khi đăng nhập.
$trigger.Delay = 'PT20S'
# Không giới hạn thời gian chạy; lỗi thì thử lại 3 lần, mỗi lần cách 1 phút; chạy cả khi dùng pin.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# Interactive: nút "Chạy quét" trên giao diện cần mở được cửa sổ Chromium trên màn hình.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Giao diện quản lý minigame Dr.Natro (npm run ui), chạy ẩn khi đăng nhập Windows.' -Force | Out-Null
Write-Host "Đã cài '$taskName': giao diện tự bật (chạy ẩn) mỗi khi đăng nhập Windows."
Write-Host "Bật ngay, hoặc khởi động lại sau khi sửa config.json: powershell -ExecutionPolicy Bypass -File .\scripts\restart-ui.ps1"
Write-Host "Nhật ký khởi động: $root\logs\ui-autostart.log"
