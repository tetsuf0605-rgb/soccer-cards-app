# themes/ — チーム壁紙

`teams.json` の `wallpaper` が指すパスの置き場所（JSONスキーマ仕様 §9-1）。

一覧でチームを**1つだけ**選んでいる間、画面の背景がそのチームのテーマに切り替わる。
壁紙が無いチーム（`wallpaper: null`）は `colors.primary` → `colors.secondary` の
配色グラデーションになる。**ファイルが置かれていない場合も配色グラデーションに
落ちる**ので、置くまで壊れない（`js/theme.js` が画像の読み込みを先に試す）。

## 規約（JSONスキーマ仕様 §9-1 の仮決め）

- 形式: JPEG
- 寸法: 縦 1170×2532 相当（iPhone縦画面）
- 容量: 300KB以下
- **自作画像**。クラブ公式素材をそのまま使わない

## 当面の対象（3件・配置済み）

| ファイル名 | チーム |
|---|---|
| `urawa-red-diamonds.jpg` | Urawa Red Diamonds |
| `fc-barcelona.jpg` | FC Barcelona |
| `aston-villa.jpg` | Aston Villa |

ファイル名は `teams.json` の `wallpaper` と一致させる。増やすときは
`teams.json` 側（データリポジトリ）も一緒に更新する。

## 差し替えるとき

元画像の縦横比がiPhone（1170:2532）と違う場合は、中央を基準に切り出す。
JPEGの品質は300KBに収まる範囲で最大にする。背景は `background-size: cover` で
表示されるので、端は切れる前提で、見せたいもの（エンブレム・スタジアム名）は
中央寄りに置く。

Service Worker の先読み（`sw.js` の `SHELL`）には**入れない**。3枚で1MB近くなり、
見ないチームのぶんまでインストール時に取ることになるため。一度表示すれば
実行時キャッシュが拾うので、2回目以降はオフラインでも出る。
