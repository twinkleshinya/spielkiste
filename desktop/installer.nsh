; A drive selected in Browse is a parent directory, not the application directory.
; electron-builder's assistedInstaller.nsh instFilesPre appends APP_FILENAME
; before extraction (F:\ becomes F:\Spielkiste). NSIS otherwise disables Install
; on the directory page before that normalization can execute.
AllowRootDirInstall true

!define MUI_DIRECTORYPAGE_TEXT_TOP "选择安装位置。选择磁盘或其他父文件夹时，会自动创建 Spielkiste 子文件夹。"
