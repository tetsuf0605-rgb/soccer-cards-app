# soccer-cards-app

サッカートレカ所持リスト PWA。iPhone Safari（ホーム画面に追加）で使う前提。
データは private リポジトリ [soccer-cards-data](https://github.com/tetsuf0605-rgb/soccer-cards-data) に置き、
GitHub Contents API で読み書きする。仕様の正はそちらの `docs/` にある4点。

## 技術方針

ビルドなしの静的構成。HTML + CSS + JavaScript（ES modules）のみで、
フレームワーク・npm依存・ビルドステップは使わない（push＝デプロイを維持するため）。

## ローカルでの動作確認

ES modules と Service Worker は `file://` では動かないので、必ずHTTPで配信する。

```sh
cd soccer-cards-app
python -m http.server 8765
```

- アプリ: <http://localhost:8765/>
- セルフテスト: <http://localhost:8765/dev/selftest.html>

## 構成

```
index.html                 画面の骨格（一覧ビュー / 設定ビュー）
css/style.css              モバイルファーストのスタイル
js/app.js                  エントリ。画面の配線と読み込みフロー
js/config.js               接続設定（PAT / owner / repo）の localStorage 入出力
js/github.js               Contents API クライアント（現在は読み取りのみ）
js/base64.js               UTF-8 経由の base64 変換
js/render.js               データ → DOM（ビュー層）
manifest.webmanifest       PWAマニフェスト（パスはすべて相対。GitHub Pagesのサブパス配信のため）
sw.js                      Service Worker（ネットワーク優先の最小構成）
icons/                     アイコン一式
dev/                       開発用。アプリ本体からは読み込まれない
```

### 設計上の約束ごと

- **書き込むのは `collection.json` だけ。** `prices.json` / `players_info.json` は
  cowork 所有のため、書き込む関数を作らない（保存同期方式仕様 §2・§3）
- **base64変換は必ずUTF-8バイト列を経由する。** 選手名や備考に日本語が入るため
  `btoa(JSON.stringify(...))` は使えない（`js/base64.js`）
- **Service Workerは同一オリジンのみ扱う。** GitHub APIのレスポンスはSWを通さない
  ＝PATで認証した個人データをキャッシュに残さない
- **Service Workerはネットワーク優先。** 古いアプリ殻を掴んで更新が届かなくなる事故を避ける

## セルフテスト

PATなしで検証できる範囲を `dev/selftest.html` にまとめている（GitHubへの実通信はしない）。
Contents API のレスポンスは `dev/fixtures.js` で差し替える。

`dev/fixtures.js` はスキーマ仕様 §3 のサンプル（架空の2枚）を Python で base64 化したもの。
アプリ側の符号器とは独立しているので、UTF-8経路の突き合わせに使える。再生成は:

```sh
python dev/gen_fixtures.py            # 既定で ../soccer-cards-data を読む
```

> **このリポジトリは public。実際の所持カードデータを `dev/` に焼き込まないこと。**
> `gen_fixtures.py` はサンプル以外を検出したら中止する。

## 実装状況

- [x] **フェーズ0** 骨格 — 設定画面（PAT / owner / repo）、Contents APIクライアント（読み）、一覧の素表示
- [ ] **フェーズ1** 一覧・詳細・8項目ソート・検索・オーバーレイマージ
- [ ] **フェーズ2** 取り込みフォーム（写真判定運用仕様 §5）＋保存（PUT・409リトライ）
- [ ] **フェーズ3** 編集・「倉庫へ移動（登録解除）」・priceWatch切替
- [ ] **フェーズ4** エクスポート・オフライン閲覧・manifest/SW仕上げ

フェーズ0の時点では一覧は `collection.json` をそのまま表示する。
オーバーレイのマージ表示はフェーズ1で入る。

## PAT について

設定画面で入力し、localStorage に保存する（保存同期方式仕様 §4）。

- Fine-grained PAT を、対象リポジトリ **`soccer-cards-data` のみ**に限定して発行する
- 権限は **Contents: Read and write**
- トークンは端末に平文で保存されるため、共用端末では使わない
