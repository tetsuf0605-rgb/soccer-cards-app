# チェックリストと GB の追加手順

Claude Code の手動セッションで、`soccer-cards-data` の `checklists/` と `gb/` を増やすときの手順。
仕様の正は `soccer-cards-data/docs/`（JSONスキーマ仕様 §9-3・§9-4・§10、写真判定運用仕様 §3・§7-3・§8）。
ここに書くのは、実際にやってみて分かった進め方と落とし穴だけ。

---

## 0. 前提の確認

```sh
cd soccer-cards-app
git -C ../soccer-cards-data fetch origin
git -C ../soccer-cards-data status --short      # クリーンであること
git -C ../soccer-cards-data log --oneline HEAD..origin/main   # 空であること
```

`teams.json` が無いとスクリプトは動かない（チーム名を正式名に寄せる基準に使う）。

---

## 1. どの製品から作るか決める

所持枚数、特に**金庫級（tier: vault）の多い製品**から。新規登録と所持照合が効く範囲がそこだから。

```sh
node dev/match_report.mjs        # 既にチェックリストがある製品の当たり具合
```

製品ごとの所持枚数は `collection.json` を productKey で集計して出す。productKey は
`dev/_common.py` の `product_key()` と同じ規則（下記）。

---

## 2. 所持カードを先に見る

**これを飛ばさない。** 出典の裏取りにも、チェックリストの設計にも効く。

- その製品で実際に使われている `variation` の異なり値 → `variations[]` に漏れがないかの基準
- `cardNo` の接頭辞 → サブセットの構成が分かる
- `serial` の分母 → パラレルのラダーが分かる。**所持カードは「その組み合わせが実在する」という一次証拠**

実例: Finest のオートは所持カードが BA-IK 246/250・BA-PG 178/199・BA-GS 009/150・BA-UD 95/99 と揃っていて、
出典ページの未確認情報（Pink /250・Aqua /199・Blue /150・Green /99）と完全に一致した。

製品によって `variation` の意味が違う:

| 製品 | variation の実体 |
|---|---|
| Topps Chrome / Finest | 色のパラレル（Refractor / Lava / X-Fractor / Geometric / Mini-Diamonds の系統 × 色） |
| Topps Flagship | 色のパラレル＋インサート名。インサートのパラレルは「インサート名＋パラレル名」（写真判定 §3-3） |
| Futera Club Unique | **サブセット名そのもの**（Heritage / Artistry / Victory …）。分母はサブセット内でもカードごとに違う |

---

## 3. 出典を当たる

当たりが良かった順:

1. **checklistinsider.com** — パラレルの print run とカード番号が verbatim で載る。Topps 系はほぼここで足りる
2. **cartophilic-info-exch.blogspot.com** — ニッチな製品（Futera 等）はこちらが詳しい
3. beckett / cardsmithsbreaks / degreegrading — 補助。**サイト間で数字が食い違うことが多い**ので単独では使わない

ページを読むときは「verbatim（ページの原文）」と「要約」を分けて扱う。長いページは一部しか原文で取れないことがある。

**出典が1つしかない項目は notes にそう書く。** 例: Flagship の `Bronze Sparkle Foil /250` は
cartophilic のみで、checklistinsider には無い。

---

## 4. 下書き JSON を作る

`dev/checklist_import.py` に渡す下書きは緩くてよい。

```json
{
  "maker": "Topps",
  "series": "Finest UEFA Club Competitions",
  "season": "2025-26",
  "coverage": "partial",
  "cardsCoverage": "partial",
  "confirmedAt": "2026-11-05",
  "sources": ["https://...", "所持カード（collection.json）で実在を確認した組み合わせを含む"],
  "variations": [
    { "name": "Base", "category": "base", "denominator": "none" },
    { "name": "Blue Refractor", "category": "parallel", "denominator": "unknown",
      "notes": "ベース Common は /200。層により少なくなる" },
    { "name": "Asia Refractor", "category": "parallel", "denominator": 99, "exclusive": "Asia" }
  ],
  "cards": [
    { "cardNo": "BA-UD", "nameEn": "Destiny Udogie", "team": "Tottenham Hotspur",
      "kind": "auto", "parallels": ["Base", "Green Refractor"], "features": ["auto"] }
  ]
}
```

- `productKey` は書かなくてよい（maker/series/season から作る）
- `team` は teams.json の別名・日本語名でもよい（正式名に寄る）
- `denominator` は 数値 / `"none"` / `"unknown"`。**分母が層やカードで変わるものは `"unknown"`**
- `parallels` は `"all"`（variations の base/parallel 全部）か、明示の配列
- **素のインサートは `"Base"` ともサブセット名とも登録されうる**ので、インサート行の `parallels` には両方入れる

書き出し:

```sh
python dev/checklist_import.py draft.json --dry-run   # 検証だけ
python dev/checklist_import.py draft.json             # checklists/{productKey}.json に書く
python dev/checklist_import.py --check                # 既存を全部検証
```

1件でもエラーがあれば何も書かずに中止する。

---

## 5. 照合して確かめる

```sh
node dev/match_report.mjs {productKey}
```

- 「所持」が増えていれば productKey と照合キーが噛み合っている
- 「チェックリストに無いパラレル名」が出たら、**台帳の表記ゆれ**か**チェックリストの未収録**のどちらか
- 「別パラレル所持」は、名前が合えば「所持」になる候補

台帳側を寄せるなら `soccer-cards-data/tools/fix_collection.py`（規則4）。
**保存同期方式仕様 §6 の例外手順**に従うこと:

```sh
cd ../soccer-cards-data
python tools/fix_collection.py            # 差分一覧（書かない）→ ユーザーに見せて承認を得る
python tools/fix_collection.py --write    # 承認後のみ
git commit -m "pc: fix collection ..."
# 直後に iPhone で PWA を再読込してもらう（sha の更新）
```

シリアルの分母が一致して候補が1つに絞れたものしか寄せない。`Green` が
Refractor / Lava / Geometric / X-Fractor のどれかは**見た目でしか決まらない**ので、
実物を見てもらう。

---

## 6. GB を足す

```sh
python dev/gb_export.py "C:/Users/tetsu/OneDrive/アプリ開発/FCGB/breaks/{breakId}" --maker Topps
python dev/gb_export.py <break_dir> --status joined   # 参加した場合
```

**FCGB の `card_id` はカード番号ではない。** `BAR_DRO` のような評価用の内部ID。
ここからカード番号を作ると所持照合が静かに外れる。`gb_export.py` は番号を作らず、
`card_name` の末尾に `(CTA-SGR)` と入っている場合だけ本物として扱う。

§9-4 の前提どおり、該当製品のチェックリストが先。無いときは中止する
（どうしても先に作るなら `--allow-missing-checklist`）。

---

## 落とし穴

- **productKey の実装は2か所**: `js/checklist.js` の `productKeyOf` と `dev/_common.py` の `product_key`。
  片方だけ直すと所持照合が静かに外れる。規則は `{season}-{maker}-{series}` をスラグ化し、
  **series が maker で始まれば maker を重ねない**（写真判定 §3-2）
- **`season` が null のカードは productKey を作れず、照合対象外**（2026-11-05 時点で87件・13製品）。
  推測で埋めない
- **インサートの複合名は台帳が正しい**。`Nitro Boost Yellow Sparkle` のような名前を
  「インサート名を剥がして `Yellow Sparkle` にする」のは §3-3 に反する。
  足りないのはチェックリスト側の複合行
- **ベースが層に分かれる製品がある**（Finest の Common/Uncommon/Rare）。同じパラレル名でも
  分母が違うので `denominator: "unknown"` にして notes に層ごとの値を書く
- データリポへ push する前に `git status` で対象ファイルだけが入っていることを確かめる

---

## コミット規約

| 内容 | メッセージ |
|---|---|
| チェックリスト | `pc: checklist {productKey}` |
| GB | `pc: gb {breakId}` |
| 台帳の一括修正 | `pc: fix collection {内容}` |
