param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$items = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$font = New-Object System.Drawing.Font('Consolas', 15, [System.Drawing.FontStyle]::Bold)
try {
  foreach ($item in $items) {
    $source = [System.Drawing.Image]::FromFile($item.input)
    $canvas = New-Object System.Drawing.Bitmap($source.Width, ($source.Height + 34))
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    try {
      $graphics.Clear([System.Drawing.Color]::Black)
      $graphics.DrawImage($source, 0, 34, $source.Width, $source.Height)
      $graphics.DrawString($item.label, $font, [System.Drawing.Brushes]::White, 8, 5)
      $canvas.Save($item.output, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    } finally { $graphics.Dispose(); $canvas.Dispose(); $source.Dispose() }
  }
} finally { $font.Dispose() }
