module.exports = {
  appId:'com.spielkiste.desktop', productName:'Spielkiste', asar:false, npmRebuild:false,
  directories:{output:'.output/desktop-release'},
  files:['desktop/**','dist/src/**','src/ui/public/**','src/templates/**','templates/**',
    '.agents/skills/video-sfx-*/**','scripts/stamp-sfx-frames.ps1','scripts/pick-folder.ps1','scripts/scan-audio-library.ps1','scripts/Spielkiste.FolderPicker.cs','package.json',
    '!src/ui/public/spielkiste-design-preview.html'],
  extraFiles:[{from:'docs/Spielkiste-使用指南.html',to:'Spielkiste-使用指南.html'}],
  extraResources:[{from:'.output/desktop-runtime',to:'runtime'},
    {from:'docs/Spielkiste-团队使用说明.md',to:'使用说明.md'},
    {from:'docs/Spielkiste-使用指南.html',to:'Spielkiste-使用指南.html'},
    {from:'docs/spielkiste-guide-assets',to:'spielkiste-guide-assets'}],
  win:{icon:'src/ui/public/assets/spielkiste.ico',target:['nsis','portable'],signExecutable:false},
  // In the pinned builder, true omits UNPACK_DIR_NAME and lets NSIS use
  // its per-launch $PLUGINSDIR. Relaunching must not delete a running app.
  portable:{artifactName:'Spielkiste-${version}-Portable.${ext}',unpackDirName:true},
  nsis:{oneClick:false,allowToChangeInstallationDirectory:true,include:'desktop/installer.nsh',createDesktopShortcut:true,shortcutName:'Spielkiste',deleteAppDataOnUninstall:false},
  artifactName:'Spielkiste-${version}-Setup.${ext}',
  publish:null
};
