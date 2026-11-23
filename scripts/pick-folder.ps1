param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
try {
  # PowerShell is only the launcher. The dialog itself runs in a normal
  # Windows GUI process; hosting WinForms inside the server's PowerShell
  # process can inherit SW_HIDE and leave the browser polling forever.
  $source = Join-Path $PSScriptRoot 'Spielkiste.FolderPicker.cs'
  $cache = Split-Path -Parent $request.resultPath
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($source))).Replace('-','').Substring(0,16) }
  finally { $sha.Dispose() }
  $helper = Join-Path $cache ('Spielkiste.FolderPicker-' + $hash + '.exe')
  if (!(Test-Path -LiteralPath $helper)) {
    $temporary = Join-Path $cache ('picker-build-' + [Guid]::NewGuid().ToString('N') + '.exe')
    try {
      Add-Type -Path $source -ReferencedAssemblies 'System.Web.Extensions','System.Windows.Forms','System.Drawing' -OutputAssembly $temporary -OutputType WindowsApplication
      if (!(Test-Path -LiteralPath $helper)) { Move-Item -LiteralPath $temporary -Destination $helper }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
  }
  # Run it directly in this interactive PowerShell desktop. Start-Process can
  # detach the GUI into a different window station under browser launches.
  $job = Start-Job -ScriptBlock { param($exe,$arg) & $exe $arg } -ArgumentList $helper,$RequestPath
  if (!(Wait-Job -Job $job -Timeout 115)) {
    Stop-Job -Job $job -Force -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    throw 'Windows folder selection timed out. Please try again.'
  }
  $job | Receive-Job -ErrorAction SilentlyContinue | Out-Null
  $exitCode = $job.ChildJobs[0].JobStateInfo.State
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  if (!(Test-Path -LiteralPath $request.resultPath)) { throw 'Windows folder picker exited without returning a result.' }
} catch {
  @{status='failed';error=$_.Exception.Message} | ConvertTo-Json -Compress | Set-Content -LiteralPath $request.resultPath -Encoding UTF8
  exit 1
}
