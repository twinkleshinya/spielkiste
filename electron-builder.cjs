module.exports = {
  appId:'com.spielkiste.desktop', productName:'Spielkiste', asar:false,
  directories:{output:'.output/desktop-release'},
  files:['desktop/**','dist/src/**','src/ui/public/**','src/templates/**','templates/**',
    '.agents/skills/video-sfx-*/**','scripts/stamp-sfx-frames.ps1','package.json',
    '!src/ui/public/spielkiste-design-preview.html'],
  extraResources:[{from:'.output/desktop-runtime',to:'runtime'}, {from:'docs/Spielkiste-团队使用说明.md',to:'使用说明.md'}],
  win:{icon:'src/ui/public/assets/spielkiste.ico',target:['nsis'],signExecutable:false},
  nsis:{oneClick:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:true,shortcutName:'Spielkiste',deleteAppDataOnUninstall:false},
  artifactName:'Spielkiste-${version}-Setup.${ext}',
  publish:null
};
