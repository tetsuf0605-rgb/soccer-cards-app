# iPhone実機確認手順

- 作成日: 2026-08-13
- 対象: `soccer-cards-app`（public / main）と `soccer-cards-data`（private / main）
- 所要: 15〜20分（うちPages公開の待ち時間が数分）
- ねらい: **本番PATでの読み書き**を実機で通すこと。ローカルではAPIをスタブに差し替えて確認済みで、
  実通信（GET / PUT）だけが未検証のまま残っている

> テストで登録する1枚は最後に「倉庫へ移動（登録解除）」で消すので、台帳は元の状態に戻る。
> 消したあともコミット履歴には残る（スキーマ仕様 §5 のとおり）。

---

## 1. GitHub Pages を有効にする（PC）

現状は未有効なので、まずここから。

**画面から**: リポジトリ `soccer-cards-app` → Settings → Pages →
Source: `Deploy from a branch` → Branch: `main` / `/ (root)` → Save

**コマンドから**:

```bash
gh api -X POST repos/tetsuf0605-rgb/soccer-cards-app/pages -f "source[branch]=main" -f "source[path]=/"
```

公開URLは `https://tetsuf0605-rgb.github.io/soccer-cards-app/`。
初回は反映まで1〜2分かかる（Actionsタブの `pages build and deployment` が緑になれば完了）。

```bash
gh api repos/tetsuf0605-rgb/soccer-cards-app/pages --jq '{url:.html_url,status:.status}'
```

- [ ] PCのブラウザで公開URLが開き、「トレカ所持リスト」の画面が出る
- [ ] 背景色や上部バーが効いている（CSS・JSが読めている＝サブパス配信でパスが壊れていない）
- [ ] この時点では一覧は空でよい（PAT未設定のため）

---

## 2. Fine-grained PAT を発行する（PC推奨）

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token

| 項目 | 設定 |
|---|---|
| Token name | `soccer-cards-iphone` |
| Expiration | 最長（カレンダーで指定） |
| Resource owner | `tetsuf0605-rgb` |
| Repository access | Only select repositories → **`soccer-cards-data` だけ** |
| Permissions | Repository permissions → **Contents: Read and write**（Metadata: Read-only は自動で付く） |

- トークンは発行直後の**1回しか表示されない**
- iPhoneへの渡し方は、パスワードマネージャ経由が安全。メモアプリ経由でもよいが、
  入力し終えたらそのメモを消す
- 前後に空白が混ざると401になるので、コピーは慎重に

- [ ] トークンを発行し、iPhoneでペーストできる状態にした

---

## 3. ホーム画面に追加する（iPhone）

1. **Safari** で公開URLを開く（Chrome等から追加してもPWAにはならない）
2. 共有 → 「ホーム画面に追加」 → 名前は「トレカリスト」でOK

- [ ] ホーム画面にアイコンが出た
- [ ] アイコンから起動するとアドレスバーが出ない（standaloneで動いている）

> ⚠️ **iOSでは Safari とホーム画面アプリで localStorage が別物**。
> Safariで入れた設定（PATを含む）はホーム画面アプリには引き継がれない。
> 以降の確認は**ホーム画面アプリ側**で行い、PATはそちらでもう一度入力する。

---

## 4. 読み取りの疎通（iPhone）

右上 ⚙ → owner `tetsuf0605-rgb` / repo `soccer-cards-data` / PATを貼る → 「保存して読み込む」

- [ ] カードが一覧に出る（初期状態ならサンプル2枚）
- [ ] ⚙ の「取得状況」で3ファイルすべてに sha とサイズが出る
- [ ] 詳細を開くと、価格の下に「prices.json（cowork更新）の値を表示しています」が出る
      （オーバーレイのマージが効いている証拠）
- [ ] 並び替え8項目が動く／検索でかな入力（例「べりんがむ」）が当たる

---

## 5. 書き込みの疎通（iPhone）— ここが未検証の本体

下のJSONをコピーして使う。**選手は既存の「三笘薫」に自動で当たる**ので、
新しい選手レコードは作られない（片付けが1枚の登録解除だけで済む）。
自分のデータで試すときは、すでに登録済みの選手の `nameEn` に置き換える。

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "card": {
        "maker": "Panini",
        "series": "疎通テスト",
        "season": "2025-26",
        "cardNo": "TEST-1",
        "variation": "疎通テスト",
        "serial": "01/10",
        "features": [],
        "teamOnCard": "Brighton & Hove Albion",
        "notes": "実機疎通テスト。確認できたら登録解除する"
      },
      "player": {
        "name": "三笘薫",
        "nameEn": "Kaoru Mitoma",
        "nationality": "日本",
        "currentTeam": "Brighton & Hove Albion",
        "status": "active"
      },
      "needsCheck": ["serial"]
    }
  ]
}
```

1. 右上 ＋ → 入力欄に貼り付け（または「クリップボードから貼り付け」）→ 「読み込む」
   - [ ] 選手が「三笘薫」に当たっていて、そのラジオが選ばれている
   - [ ] シリアル欄が色つきで囲まれ「要確認」が付いている
2. チェックを入れずに「保存する」
   - [ ] 「シリアルが実物と一致することを確認して…」で止まる（＝安全弁が効いている）
3. チェックを入れて「保存する」
   - [ ] 「保存しました（c-…）」が出る
   - [ ] `soccer-cards-data` のコミットに **`iphone: add c-…`** がある
4. そのカードの詳細 → 「編集する」→ 備考を書き換え → 「変更を保存」
   - [ ] **`iphone: edit c-…`**／詳細の表示も変わる
5. 詳細 → 「価格ウォッチに入れる」
   - [ ] **`iphone: edit c-…`**／バッジが付く
6. 詳細 → 「倉庫へ移動（登録解除）」→ 確認パネルの「登録解除する」
   - [ ] **`iphone: delete c-…`**／一覧が元の枚数に戻る

- [ ] GitHub側で `collection.json` の中身を開き、体裁（1カード＝1ブロック）が崩れていない
- [ ] 日本語（選手名・備考）が文字化けしていない

---

## 6. オフライン確認（iPhone）

1. アプリを開いたまま**機内モードON** → ↻ を押す
   - [ ] 「閲覧のみ（◯◯取得の保存分を表示中）」のバナーが出る
   - [ ] ＋ と、詳細の「編集する」「価格ウォッチ」「倉庫へ移動」が押せない
   - [ ] 一覧・詳細は今までどおり見られる
2. アプリを終了（Appスイッチャーで上スワイプ）→ **機内モードのまま起動**
   - [ ] 白紙にならず一覧が出る（Service Workerのキャッシュ＋保存分）
3. 機内モードOFF → ↻
   - [ ] バナーが消えて、ボタンが戻る

---

## 7. エクスポート確認（iPhone）

⚙ → エクスポート → 「共有」

- [ ] 共有シートが出て、「ファイルに保存」でiCloud Driveや本体に置ける
- [ ] 置いたファイルを開くと、価格・所属がマージ済みの単一 `collection.json`（v1.2形式）になっている

（共有シートが出ない端末では「ダウンロード」を使う）

---

## 8. 更新の届き方

Service Workerはネットワーク優先なので、アプリを起動し直せば新しい版を取りに行く。
反映されないときは、アプリを終了してから起動し直す。

- [ ] PC側で何か1文字直してpush → 数分後にアプリを再起動して反映されること（任意）

---

## つまずいたときは

| 症状 | 原因 | 対処 |
|---|---|---|
| 「〜が見つかりません（404）」 | PATの対象リポジトリに `soccer-cards-data` を入れ忘れ／repo名の綴り違い | 権限不足でも404になる。PATの対象と設定画面のrepoを両方確認 |
| 「PATが無効か期限切れです」（401） | コピペで前後に空白が入った／欠けた／期限切れ | 設定画面で入れ直す |
| 「Contents: Read and write か確認してください」（403） | 権限がRead-onlyのまま | PATを発行し直す |
| 保存で「競合しました」 | 別端末やcoworkと同時更新 | 自動で1回取り直して再保存する。それでも出たら ↻ で読み直してからやり直す |
| ホーム画面アプリでPATが空 | SafariとPWAでlocalStorageが別 | アプリ側でもう一度入力する（仕様どおりの挙動） |
| 公開URLが404のまま | Pagesのビルド待ち／Sourceの指定違い | Actionsの `pages build and deployment` を確認。Branchは `main` / `/ (root)` |
| 画面が古いまま | 起動中のPWAが前の殻を掴んでいる | アプリを終了して起動し直す |
| 「クリップボードを読めませんでした」 | 貼り付けAPIが使えない状況 | 入力欄を長押しして「ペースト」する |

---

## この手順では確認できないもの

- coworkのスケジュールタスクからの `git push`（保存同期方式仕様 §5 の要実機検証。未決定事項#7）
- 実データ量での表示速度（いまはサンプル2枚のため）
- まとめ撮り（複数枚）の取り込み — 判定プロジェクトの指示文ができてから実写真で試す
