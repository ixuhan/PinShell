$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$dir = 'f:\PinShell\src-tauri\icons'
New-Item -ItemType Directory -Path $dir -Force | Out-Null

$size = 64
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(11, 14, 20))
$rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(78, 201, 160),
  [System.Drawing.Color]::FromArgb(122, 162, 247),
  45
)
$g.FillEllipse($brush, 10, 10, 44, 44)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(11, 14, 20), 5)
$g.DrawString('>_', (New-Object System.Drawing.Font('Consolas', 18, [System.Drawing.FontStyle]::Bold)), [System.Drawing.Brushes]::Black, 12, 20)
$g.Dispose()

$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$fs = [IO.File]::Create((Join-Path $dir 'icon.ico'))
$icon.Save($fs)
$fs.Close()
$bmp.Save((Join-Path $dir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Get-ChildItem $dir | Select-Object Name, Length
