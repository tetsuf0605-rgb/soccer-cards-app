/**
 * 一覧の絞り込みと並び替え。
 *
 * 8項目のソートはスキーマ仕様 §1「ソート要件との対応」表のとおり。
 * 選手側のキー（名前・国籍・現所属チーム・引退状況）は playerId で結合して引く。
 */

/** カードと選手を結合した1行。 */
export function buildRows(merged) {
  const playersById = new Map((merged?.players ?? []).map((player) => [player.id, player]));
  return (merged?.cards ?? []).map((card) => ({
    card,
    player: playersById.get(card.playerId) ?? null,
  }));
}

/** 引退状況の並び順。現役 → 引退 → 不明。 */
const STATUS_RANK = { active: 0, retired: 1, unknown: 2 };

/**
 * ソート項目の定義。value が null / '' を返した行は、方向に関わらず末尾に送る。
 * スキーマ仕様 §1 の対応表と1対1で対応させている。
 */
export const SORT_OPTIONS = [
  { id: 'name', label: '名前', value: (row) => row.player?.name },
  { id: 'nationality', label: '国籍', value: (row) => row.player?.nationality },
  { id: 'price', label: '現在の価格', numeric: true, defaultDesc: true, value: (row) => row.card.price?.current },
  { id: 'teamOnCard', label: 'プリント時チーム', value: (row) => row.card.teamOnCard },
  { id: 'currentTeam', label: '現所属チーム', value: (row) => row.player?.currentTeam },
  {
    id: 'status',
    label: '引退状況',
    numeric: true,
    // 文字列順ではなく意味の順に並べる（ロケールに依存させない）
    value: (row) => STATUS_RANK[row.player?.status] ?? (row.player?.status ? 3 : null),
  },
  { id: 'series', label: 'シリーズ', value: (row) => row.card.series },
  { id: 'variation', label: 'バリエーション', value: (row) => row.card.variation },
];

export const DEFAULT_SORT_ID = 'name';

export function findSortOption(id) {
  return SORT_OPTIONS.find((option) => option.id === id) ?? SORT_OPTIONS[0];
}

// numeric: true で「Prizm 2」が「Prizm 10」より前に来る
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

function isEmpty(value) {
  return value === null || value === undefined || value === '';
}

/** 同値のときの決定的な順序。表示が揺れないように必ず最後まで決める。 */
function tiebreak(a, b) {
  return collator.compare(a.player?.name ?? '', b.player?.name ?? '')
    || collator.compare(a.card.series ?? '', b.card.series ?? '')
    || collator.compare(a.card.variation ?? '', b.card.variation ?? '')
    || collator.compare(a.card.id, b.card.id);
}

/**
 * 並び替えた新しい配列を返す（入力は書き換えない）。
 * @param {Array} rows
 * @param {string} sortId
 * @param {boolean} desc
 */
export function sortRows(rows, sortId, desc) {
  const option = findSortOption(sortId);
  return [...rows].sort((rowA, rowB) => {
    const a = option.value(rowA);
    const b = option.value(rowB);
    const aEmpty = isEmpty(a);
    const bEmpty = isEmpty(b);

    // 値なしは昇順・降順どちらでも末尾（探しているものが下に埋もれないように）
    if (aEmpty || bEmpty) {
      if (aEmpty && bEmpty) return tiebreak(rowA, rowB);
      return aEmpty ? 1 : -1;
    }

    const base = option.numeric ? a - b : collator.compare(String(a), String(b));
    if (base !== 0) return desc ? -base : base;
    return tiebreak(rowA, rowB);
  });
}

/**
 * 検索用の正規化。
 * NFKCで全角/半角を吸収し、小文字化し、ひらがなをカタカナに寄せる
 * （iPhoneのかな入力で「べりんがむ」と打っても「ベリンガム」に当たるように）。
 */
export function foldText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

/**
 * 選手名（name / nameEn）での絞り込み。
 * @param {Array} rows
 * @param {string} queryText
 */
export function filterRows(rows, queryText) {
  const needle = foldText(queryText).trim();
  if (!needle) return rows;
  return rows.filter((row) => {
    const name = foldText(row.player?.name);
    const nameEn = foldText(row.player?.nameEn);
    return name.includes(needle) || nameEn.includes(needle);
  });
}
