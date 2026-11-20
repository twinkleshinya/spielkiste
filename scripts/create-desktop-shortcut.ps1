$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Launcher = Join-Path $Root "Spielkiste.bat"

if (-not (Test-Path $Launcher)) {
  throw "找不到启动器：$Launcher"
}

$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "Spielkiste.lnk"

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Launcher
$Shortcut.WorkingDirectory = $Root
$Shortcut.Description = "一键启动 Spielkiste 视频音效工作台"
$Shortcut.IconLocation = (Join-Path $Root "src\ui\public\assets\spielkiste.ico")
$Shortcut.Save()

Write-Host "已创建桌面快捷方式：$ShortcutPath" -ForegroundColor Green

