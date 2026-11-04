/**
 * 文字列の正規化。
 *
 * 検索・突き合わせの「寄せ方」を1か所にまとめる。ここに依存するのは
 * query.js（フリーワード検索・ソート）/ refdata.js（チーム名）/ ingest.js
 * （判定JSONの選手マッチ）で、どれも同じ寄せ方でないと「打ったのに出ない」
 * 「同じチームが2つに割れる」が起きる。
 */

/**
 * 検索用の正規化。
 *
 * NFKCで全角/半角を吸収し、小文字化し、ひらがなをカタカナに寄せる
 * （iPhoneのかな入力で「べりんがむ」と打っても「ベリンガム」に当たるように）。
 * スキーマ仕様 §1「部分一致・大文字小文字無視・NFKC正規化・カナ/かな同一視」。
 */
export function foldText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

/**
 * 名前の突き合わせキー（チーム名・選手のnameEn）。
 *
 * カード印字は「A.F.C. Bournemouth」「AFC Bournemouth」のように区切り記号が
 * 揺れ、「Atlético」「Atletico」のようにアクセント記号も揺れる。foldText に
 * 加えて、アクセント記号・記号・空白を落として「同じ名前」と見なす。
 */
export function matchKey(text) {
  return foldText(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s.,'’`\-_/·・]/g, '');
}
