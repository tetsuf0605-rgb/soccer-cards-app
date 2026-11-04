/**
 * collection.json のテキスト化。
 *
 * コミット履歴そのものが台帳（保存同期方式仕様 §7）なので、体裁は
 * スキーマ仕様 §3 のサンプルに合わせる。カード1枚が1ブロックになり、
 * 1枚追加したときの差分がその1ブロックだけで収まる。
 *
 * 体裁のルール:
 *   - インデントは2スペース
 *   - オブジェクトは深さ2まで展開（root / players[] / cards[] の各要素）
 *   - それより深いオブジェクト（storage / price / 履歴の1件）は1行
 *   - 配列は、中身がすべてスカラーなら1行（features）、オブジェクトを含むなら展開
 *
 * キーの順序は入力オブジェクトのまま保つ（構築側でスキーマ順に作る）。
 * 未知のフィールドがあっても落とさない。
 */

const INDENT = '  ';

/** collection.json でオブジェクトを1行に畳む深さ。root=0, players/cards=1, その要素=2。 */
const COLLECTION_INLINE_FROM = 3;

/** targets.json は1件1行（スキーマ仕様 §9-2 のサンプルどおり）。root=0, targets=1, その要素=2。 */
const TARGETS_INLINE_FROM = 2;

function isScalar(value) {
  return value === null || typeof value !== 'object';
}

function format(value, depth, inlineFrom) {
  if (isScalar(value)) return JSON.stringify(value);

  const pad = INDENT.repeat(depth);
  const inner = INDENT.repeat(depth + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isScalar)) return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
    const items = value.map((item) => inner + format(item, depth + 1, inlineFrom));
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';

  if (depth >= inlineFrom) {
    const pairs = entries.map(([key, item]) => `${JSON.stringify(key)}: ${format(item, depth + 1, inlineFrom)}`);
    return `{ ${pairs.join(', ')} }`;
  }

  const pairs = entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${format(item, depth + 1, inlineFrom)}`);
  return `{\n${pairs.join(',\n')}\n${pad}}`;
}

/**
 * collection.json の本文を作る（末尾に改行を付ける）。
 * @param {object} collection
 * @returns {string}
 */
export function stringifyCollection(collection) {
  return `${format(collection, 0, COLLECTION_INLINE_FROM)}\n`;
}

/**
 * targets.json の本文を作る（スキーマ仕様 §9-2）。
 *
 * 狙い選手1件が1行になるので、追加・削除の差分がその1行だけで収まる。
 * @param {object} targets
 * @returns {string}
 */
export function stringifyTargets(targets) {
  return `${format(targets, 0, TARGETS_INLINE_FROM)}\n`;
}
