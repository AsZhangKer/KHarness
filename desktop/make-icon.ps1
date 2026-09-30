# Build build/icon.ico by hand: electron-builder's bundled icon converter dies on this
# machine with "WebAssembly.Memory(): could not allocate memory", so we resize with GDI+
# and wrap the PNGs into a Vista+ multi-size ICO (PNG-in-ICO is legal).
# NOTE: keep this file pure ASCII - PowerShell 5.1 reads BOM-less files as ANSI and
# mangles non-ASCII comments in ways that break the script.
Add-Type -AssemblyName System.Drawing

$buildDir = Join-Path $PSScriptRoot '..\build'
$src = Join-Path $buildDir 'icon.png'
$out = Join-Path $buildDir 'icon.ico'
$sizes = @(16, 32, 48, 256)

$orig = [System.Drawing.Image]::FromFile($src)
$blobs = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($orig, 0, 0, $s, $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $blobs += ,($ms.ToArray())
  $ms.Dispose()
}
$orig.Dispose()

$ms2 = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($ms2)
$w.Write([UInt16]0)
$w.Write([UInt16]1)
$w.Write([UInt16]$blobs.Count)
$offset = 6 + (16 * $blobs.Count)
for ($i = 0; $i -lt $blobs.Count; $i++) {
  $s = $sizes[$i]
  $b = $blobs[$i]
  if ($s -ge 256) { $dim = 0 } else { $dim = $s }
  $w.Write([Byte]$dim)
  $w.Write([Byte]$dim)
  $w.Write([Byte]0)
  $w.Write([Byte]0)
  $w.Write([UInt16]1)
  $w.Write([UInt16]32)
  $w.Write([Int32]$b.Length)
  $w.Write([Int32]$offset)
  $offset += $b.Length
}
foreach ($b in $blobs) { $w.Write($b) }
$w.Flush()
[System.IO.File]::WriteAllBytes($out, $ms2.ToArray())
$w.Dispose()
$ms2.Dispose()
$len = (Get-Item $out).Length
Write-Output ("icon.ico {0} bytes, {1} sizes" -f $len, $blobs.Count)
