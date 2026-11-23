param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
try {
  # Run the WinForms dialog in this interactive STA PowerShell process. A
  # separately compiled helper can land in a different Windows desktop/session
  # and has repeatedly produced an invisible process with MainWindowHandle=0.
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $owner = New-Object System.Windows.Forms.Form
  $owner.Text = [string]$request.description
  $owner.StartPosition = 'CenterScreen'
  $owner.Width = 1; $owner.Height = 1
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = [string]$request.description
  $dialog.ShowNewFolderButton = $false
  if ($request.initialPath -and (Test-Path -LiteralPath ([string]$request.initialPath) -PathType Container)) {
    $dialog.SelectedPath = [string]$request.initialPath
  }
  $owner.Add_Shown({ $owner.Activate(); $owner.BringToFront(); $result = $dialog.ShowDialog($owner); if ($result -eq [System.Windows.Forms.DialogResult]::OK) { @{status='success';path=$dialog.SelectedPath} | ConvertTo-Json -Compress | Set-Content -LiteralPath $request.resultPath -Encoding UTF8 } else { @{status='cancelled'} | ConvertTo-Json -Compress | Set-Content -LiteralPath $request.resultPath -Encoding UTF8 }; $owner.Close() })
  $owner.ShowDialog() | Out-Null
  $owner.Dispose(); $dialog.Dispose()
  if (!(Test-Path -LiteralPath $request.resultPath)) { throw 'Windows folder picker exited without returning a result.' }
} catch {
  @{status='failed';error=$_.Exception.Message} | ConvertTo-Json -Compress | Set-Content -LiteralPath $request.resultPath -Encoding UTF8
  exit 1
}
