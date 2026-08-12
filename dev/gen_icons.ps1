# dev/icon-source.png から icons/ の4枚を作り直す。
#
#   powershell -ExecutionPolicy Bypass -File dev/gen_icons.ps1
#
# Pillow などを入れずに済むよう、Windows標準の System.Drawing を使う。
# アイコンを描き替えたら icon-source.png を差し替えてこれを実行し、
# sw.js の CACHE_NAME を1つ上げる（古い殻のキャッシュを掴ませないため）。

Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $PSScriptRoot 'icon-source.png'
$iconDir = Join-Path $root 'icons'

# 余白の色。元画像の地色（ほぼ黒）に合わせる＝maskableの余白が縁として見えない
$pad = [System.Drawing.Color]::FromArgb(255, 13, 13, 13)

function Render([string]$dest, [int]$size, [double]$scale) {
  $image = [System.Drawing.Image]::FromFile($source)
  $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear($pad)

  $inner = [int][Math]::Round($size * $scale)
  $offset = [int][Math]::Round(($size - $inner) / 2)
  $g.DrawImage($image, $offset, $offset, $inner, $inner)

  $g.Dispose()
  $bitmap.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  $image.Dispose()
  '{0,-26} {1,4}px  scale {2}' -f (Split-Path $dest -Leaf), $size, $scale
}

# purpose:any とアップルのタッチアイコンは、元画像をそのまま使う（フルブリード）。
# iOSは自前の角丸マスクをかけるが、金の枠は内側に十分入っているので切れない。
Render (Join-Path $iconDir 'icon-192.png') 192 1.0
Render (Join-Path $iconDir 'icon-512.png') 512 1.0
Render (Join-Path $iconDir 'apple-touch-icon-180.png') 180 1.0

# purpose:maskable は、どんなマスク形状（円・角丸・しずく）で抜かれても
# 中身が欠けないように内側70%へ収める。地色はキャンバス全面に敷く
Render (Join-Path $iconDir 'icon-512-maskable.png') 512 0.70
