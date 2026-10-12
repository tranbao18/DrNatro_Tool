# Bật hoặc khởi động lại giao diện quản lý chạy ẩn (dùng sau khi sửa config.json).
# Chạy:  powershell -ExecutionPolicy Bypass -File .\scripts\restart-ui.ps1
$ErrorActionPreference = 'Stop'
$taskName = 'DrNatro Minigame UI'
$root = Split-Path -Parent $PSScriptRoot
$port = 4321
$cfgFile = Join-Path $root 'config.json'
if (Test-Path $cfgFile) {
  $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.ui -and $cfg.ui.port) { $port = [int]$cfg.ui.port }
}
if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
  throw "Chưa cài '$taskName'. Chạy scripts\setup-ui-autostart.ps1 trước."
}

# Không khởi động lại khi đang quét: lần quét bấm từ giao diện ghi log qua giao diện, tắt ngang sẽ làm hỏng nó.
try {
  $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/status" -TimeoutSec 5
  if ($status.running) {
    Write-Host 'Đang có lần quét chạy. Chờ quét xong rồi chạy lại script này.'
    exit 1
  }
} catch {
  # Giao diện chưa chạy: bật mới.
}

# Task Scheduler không tự dừng tiến trình con, nên dừng đúng tiến trình node của giao diện đang giữ cổng.
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
foreach ($conn in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)"
  if ($proc -and $proc.Name -eq 'node.exe' -and $proc.CommandLine -match 'src[\\/]index\.js"?\s+ui') {
    Stop-Process -Id $proc.ProcessId -Force
  } elseif ($proc) {
    throw "Cổng $port đang bị chương trình khác dùng ($($proc.Name), PID $($proc.ProcessId)). Đổi ui.port trong config.json hoặc tắt chương trình đó."
  }
}
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName $taskName

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Giao diện đã chạy ẩn: http://127.0.0.1:$port/"
    exit 0
  }
}
Write-Host "Giao diện chưa lên sau 20 giây. Xem lỗi trong $root\logs\ui-autostart.log"
exit 1
