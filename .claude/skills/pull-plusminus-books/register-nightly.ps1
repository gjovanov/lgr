# Registers, or replaces, the Task Scheduler task that runs nightly.ts: every two hours from 07:00 to 23:00, as the signed-in
# user and only while they are signed in (the WSL docs root and roomler's sign-in are theirs), with no window, an hour at most,
# never two runs at once, and a missed start made up when the PC wakes.
#
#   powershell -NoProfile -File register-nightly.ps1 -Checkout C:\dev\gjovanov\lgr-books-nightly
#   powershell -NoProfile -File register-nightly.ps1 -Remove
param([string]$Checkout, [switch]$Remove, [string]$Name = 'LGR books nightly')
$ErrorActionPreference = 'Stop'
if ($Remove) { Unregister-ScheduledTask -TaskName $Name -Confirm:$false; "removed: $Name"; return }
if (-not $Checkout) { throw '-Checkout <the pinned worktree the task runs from> is required' }
$launcher = Join-Path $Checkout '.claude\skills\pull-plusminus-books\run-hidden.vbs'
if (-not (Test-Path $launcher)) { throw "no $launcher" }
$bun = (Get-Command bun -ErrorAction Stop).Source

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$launcher`" `"$bun`"" -WorkingDirectory $Checkout
$trigger = New-ScheduledTaskTrigger -Daily -At 07:00
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At 07:00 -RepetitionInterval (New-TimeSpan -Hours 2) -RepetitionDuration (New-TimeSpan -Hours 16)).Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force `
  -Description "FR-25: the books PC's newest PlusMinus archive into regal-acc, books only (.claude/skills/pull-plusminus-books/nightly.ts)." | Out-Null
Get-ScheduledTask -TaskName $Name | Get-ScheduledTaskInfo | Select-Object TaskName, NextRunTime, LastRunTime, LastTaskResult
