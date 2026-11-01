# Remote half of pull.sh. Runs on the store PC under Windows PowerShell 5.1.
# pull.sh prepends: $Mode ('list' | 'get'), $Since/$Until ('yyyy-MM-dd HH:mm', the
# PC's local time), $Names (get), $Offset/$Count (get: a byte range, 0 = to the end),
# $PmRoot (the PlusMinus CLIENT's own install folder on THIS pc — differs per store,
# see pull.sh's --pm-root comment).
# Output is ASCII only: `roomler ssh` mangles any byte that is not valid UTF-8.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Join-Path $PmRoot 'exports'
# The firm folder is "РЕГАЛ   ООД" (three spaces); find it rather than spell it.
$firm = (Get-ChildItem -LiteralPath (Join-Path $root 'docs') -Directory | Select-Object -First 1).FullName
$pdf = '^(invoicem|invoiceProf|stokrazp|sklrazp|sklisk)_\d+\.pdf$'
$xls = '^(storeAvailability|salesAnalysis|storeOperations|docJournalReport)_\d{8}_\d{6}\.xlsx$'
$sha = [Security.Cryptography.SHA256]::Create()
function Hex($b) { [BitConverter]::ToString($sha.ComputeHash($b)).Replace('-', '').ToLower() }

if ($Mode -eq 'list') {
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $s = [datetime]::ParseExact($Since, 'yyyy-MM-dd HH:mm', $inv)
  $u = [datetime]::ParseExact($Until, 'yyyy-MM-dd HH:mm', $inv)
  $all = @(Get-ChildItem -LiteralPath $firm -File | Where-Object { $_.Name -match $pdf }) +
         @(Get-ChildItem -LiteralPath $root -File | Where-Object { $_.Name -match $xls })
  $n = 0
  foreach ($f in ($all | Where-Object { $_.LastWriteTime -ge $s -and $_.LastWriteTime -lt $u } | Sort-Object Name)) {
    $b = [IO.File]::ReadAllBytes($f.FullName)
    'FILE {0} {1} {2} {3:yyyy-MM-ddTHH:mm:ss}' -f $f.Name, $b.Length, (Hex $b), $f.LastWriteTime
    $n++
  }
  # Excel's lock file means someone has an export open; its bytes may be mid-save.
  Get-ChildItem -LiteralPath $root -Force -Filter '~$*' | ForEach-Object { 'LOCK ' + $_.Name }
  'END ' + $n
  return
}

foreach ($name in $Names) {
  $dir = if ($name -match $pdf) { $firm } elseif ($name -match $xls) { $root } else { $null }
  $p = if ($dir) { Join-Path $dir $name } else { $null }
  if (-not $p -or -not (Test-Path -LiteralPath $p)) { 'MISSING ' + $name; continue }
  $b = [IO.File]::ReadAllBytes($p)
  $o = [int]$Offset
  $c = if ([int]$Count -gt 0) { [Math]::Min([int]$Count, $b.Length - $o) } else { $b.Length - $o }
  'BEGIN {0} {1} {2}' -f $name, $o, $c
  [Convert]::ToBase64String($b, $o, $c, [Base64FormattingOptions]::InsertLineBreaks)
  'END ' + $name
}
'DONE'
