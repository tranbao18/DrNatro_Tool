# Tạo tác vụ Windows Task Scheduler chạy tool mỗi giờ, kèm một lần chạy chốt cuối trước mốc freezeAt.
# Chạy trong PowerShell (không cần quyền admin):
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-schedule.ps1
# Khi đổi freezeAt hoặc finalRunLeadMinutes trong config.json, chạy lại script này để cập nhật lịch.
$ErrorActionPreference = 'Stop'
$taskName = 'DrNatro Minigame Tool'
$root = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $root 'scripts\run.cmd'

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$runner`"" -WorkingDirectory $root
$triggers = @(
  New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 365)
)

# Lần chạy chốt cuối = freezeAt trừ finalRunLeadMinutes (mặc định 15 phút), để số liệu cuối cùng sát giờ chốt.
$finalRun = $null
$configPath = Join-Path $root 'config.json'
if (Test-Path $configPath) {
  $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $lead = 15
  if ($null -ne $config.finalRunLeadMinutes) { $lead = [double]$config.finalRunLeadMinutes }
  if ($config.freezeAt -and $lead -gt 0) {
    # PowerShell 7 tự đổi chuỗi ngày trong JSON thành DateTime, PowerShell 5.1 thì giữ chuỗi.
    if ($config.freezeAt -is [datetime]) {
      $freeze = $config.freezeAt.ToLocalTime()
    } else {
      $freeze = [DateTimeOffset]::Parse([string]$config.freezeAt, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime
    }
    $finalRun = $freeze.AddMinutes(-$lead)
    if ($finalRun -gt (Get-Date)) {
      $triggers += New-ScheduledTaskTrigger -Once -At $finalRun
    } else {
      $finalRun = $null
    }
  }
}

# Mặc định Windows không chạy tác vụ khi máy dùng pin và dừng tác vụ khi rút sạc: tắt hai giới hạn đó.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 50) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Đã tạo tác vụ '$taskName': chạy mỗi 1 giờ khi bạn đang đăng nhập Windows (kể cả khi máy dùng pin)."
if ($finalRun) { Write-Host "Lần chạy chốt cuối: $($finalRun.ToString('dd/MM/yyyy HH:mm'))." }
Write-Host "Xem log tại: $root\logs\scheduler.log"
Write-Host "Gỡ tác vụ: powershell -ExecutionPolicy Bypass -File .\scripts\remove-schedule.ps1"
