$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseId = Get-Date -Format "yyyyMMdd-HHmmssfff"
$releaseRoot = Join-Path $workspace ".output\releases"
$stageRoot = Join-Path $releaseRoot "$releaseId\Spielkiste"
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

# Explicit allowlist: never copy runtime projects, local credentials or media.
foreach ($name in @("src", "tests", "templates")) {
    Copy-Item -LiteralPath (Join-Path $workspace $name) -Destination $stageRoot -Recurse -Force
}
foreach ($name in @("package.json", "package-lock.json", "tsconfig.json", ".env.example", ".gitignore", "Spielkiste.bat", "start-sfx.bat", "start-ui.bat")) {
    Copy-Item -LiteralPath (Join-Path $workspace $name) -Destination $stageRoot -Force
}
$stageScripts = Join-Path $stageRoot "scripts"
New-Item -ItemType Directory -Path $stageScripts -Force | Out-Null
foreach ($name in @("start-sfx.mjs", "start-web.mjs", "tool-git.mjs", "create-sfx-demo.mjs", "create-desktop-shortcut.ps1", "stamp-sfx-frames.ps1", "package-spielkiste.ps1")) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $stageScripts -Force
}
$stageSkills = Join-Path $stageRoot ".agents\skills"
New-Item -ItemType Directory -Path $stageSkills -Force | Out-Null
foreach ($name in @("video-sfx-workflow", "video-sfx-timing", "video-sfx-selection", "video-sfx-mix-review")) {
    Copy-Item -LiteralPath (Join-Path $workspace ".agents\skills\$name") -Destination $stageSkills -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $workspace "tool-git.json") -Destination $stageRoot -Force
$stageDocs = Join-Path $stageRoot "docs"
New-Item -ItemType Directory -Path $stageDocs -Force | Out-Null
$guide = Get-ChildItem -LiteralPath (Join-Path $workspace "docs") -Filter "Spielkiste-*.md" -File |
    Where-Object { $_.Name -notmatch "20\d\d-\d\d-\d\d" } |
    Select-Object -First 1
if (-not $guide -or -not $guide.Exists) { throw "Expected the Spielkiste team guide under docs/." }
Copy-Item -LiteralPath $guide.FullName -Destination $stageDocs -Force
Copy-Item -LiteralPath $guide.FullName -Destination (Join-Path $stageRoot "README.md") -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = Join-Path $releaseRoot "Spielkiste-$releaseId.zip"
[System.IO.Compression.ZipFile]::CreateFromDirectory($stageRoot, $archive, [System.IO.Compression.CompressionLevel]::Optimal, $true)
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    $forbidden = @($names | Where-Object { $_ -match '(^|/)(\.env|ai-config\.json|ai-test-state\.json|auth\.json|config\.toml|\.git|node_modules|dist|\.output|projects|Audio|Video)(/|$)' -or $_ -match '\.(mp4|wav|mp3|flac|ogg|m4a)$' })
    if ($forbidden.Count) { throw "Release contains local data: $($forbidden -join ', ')" }
    foreach ($required in @("src/sfx/SfxAiConfig.ts", "templates/spielkiste-default.rpp", "scripts/start-sfx.mjs", "Spielkiste.bat", "start-sfx.bat", "package-lock.json", ".env.example", ".agents/skills/video-sfx-workflow/SKILL.md", "docs/$($guide.Name)")) {
        if ($names -notcontains "Spielkiste/$required") { throw "Missing release file: $required" }
    }
    [PSCustomObject]@{ archive = $archive; files = $zip.Entries.Count; bytes = (Get-Item -LiteralPath $archive).Length; sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash } | ConvertTo-Json
} finally { $zip.Dispose() }
