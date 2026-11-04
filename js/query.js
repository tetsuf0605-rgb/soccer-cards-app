/**
 * 一覧の絞り込みと並び替え。
 *
 * 9項目のソートはスキーマ仕様 §1「ソート要件との対応」表のとおり。
 * 選手側のキー（名前・国籍・年齢・現所属チーム・引退状況）は playerId で
 * 結合して引く。フリーワード検索とチップ絞り込みは同 §1「検索・絞り込み要件
 * との対応」のとおり。
 */
import { foldText } from './text.js';
import { resolveTeam, teamIdsForRow, DEFAULT_TEAM_MODE } from './refdata.js';

// 以前からこのモジュール経由で使われているので、そのまま出し直す
export { foldText };

/**
 * カードと選手を結合した1行。
 *
 * career（在籍履歴）は collection.json に無く players_info.json のオーバーレイ
 * なので、merge.js が返す Map から行に添える（スキーマ仕様 §9-5）。
 *
 * @param {object} merged mergeCollection の merged
 * @param {Map<string, Array<object>>} [career] mergeCollection の career
 */
export function buildRows(merged, career) {
  const playersById = new Map((merged?.players ?? []).map((player) => [player.id, player]));
  return (merged?.cards ?? []).map((card) => ({
    card,
    player: playersById.get(card.playerId) ?? null,
    career: career?.get(card.playerId) ?? null,
  }));
}

/** 引退状況の並び順。現役 → 引退 → 不明。 */
const STATUS_RANK = { active: 0, retired: 1, unknown: 2 };

/**
 * birthDate（YYYY-MM-DD）から満年齢を出す（スキーマ仕様 §1「年齢はデータに持たない」）。
 * 読めない・未設定は null（一覧では「—」、ソートでは末尾）。
 *
 * @param {string|null|undefined} birthDate
 * @param {Date} [today]
 * @returns {number|null}
 */
export function ageFromBirthDate(birthDate, today = new Date()) {
  const found = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(birthDate ?? '').trim());
  if (!found) return null;

  const year = Number(found[1]);
  const month = Number(found[2]);
  const day = Number(found[3]);

  const birth = new Date(year, month - 1, day);
  // 2月30日のような存在しない日付は Date が繰り上げる。弾いておく
  if (birth.getFullYear() !== year || birth.getMonth() !== month - 1 || birth.getDate() !== day) return null;

  let age = today.getFullYear() - year;
  const monthDiff = (today.getMonth() + 1) - month;
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < day)) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

/**
 * ソート項目の定義。value が null / '' を返した行は、方向に関わらず末尾に送る。
 * スキーマ仕様 §1 の対応表と1対1で対応させている。
 */
export const SORT_OPTIONS = [
  { id: 'name', label: '名前', value: (row) => row.player?.name },
  { id: 'nationality', label: '国籍', value: (row) => row.player?.nationality },
  { id: 'age', label: '年齢', numeric: true, value: (row) => ageFromBirthDate(row.player?.birthDate) },
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

/* ===== フリーワード検索（スキーマ仕様 §1） ===== */

/** 照合するチーム名に、teams.json の正式名・日本語名・別名を足す。 */
function teamTerms(index, name) {
  const team = resolveTeam(index, name);
  if (!team) return [];
  return [team.name, team.nameJa, ...(team.aliases ?? [])];
}

/**
 * 1行の照合対象をひとつの文字列にまとめる。
 *
 * 対象はスキーマ仕様 §1 のとおり: players の name / nameEn / nationality /
 * currentTeam、cards の teamOnCard / series / variation / maker / season /
 * cardNo / serial / notes / storage.name。チーム名の照合には teams.json の
 * aliases も使う（「Villa」で Aston Villa のカードが出る）。
 *
 * @param {{card: object, player: object|null}} row
 * @param {object|null} index buildTeamIndex の戻り値（無くても動く）
 * @returns {string} foldText 済みの照合文字列
 */
export function searchHaystack(row, index) {
  const { card, player } = row;
  const parts = [
    player?.name, player?.nameEn, player?.nationality, player?.currentTeam,
    card.teamOnCard, card.series, card.variation, card.maker, card.season,
    card.cardNo, card.serial, card.notes, card.storage?.name,
  ];
  if (index && !index.isEmpty) {
    parts.push(...teamTerms(index, card.teamOnCard), ...teamTerms(index, player?.currentTeam));
  }
  return parts.filter(Boolean).map(foldText).join('\u0000');
}

/**
 * フリーワードでの絞り込み。複数語は空白区切りでAND、ヒット単位はカード。
 *
 * @param {Array} rows
 * @param {string} queryText
 * @param {object|null} [index] チームマスタの索引（aliases照合に使う）
 */
export function filterRows(rows, queryText, index) {
  const needles = foldText(queryText).trim().split(/\s+/).filter(Boolean);
  if (needles.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = searchHaystack(row, index);
    return needles.every((needle) => haystack.includes(needle));
  });
}

/* ===== チップ絞り込み（スキーマ仕様 §1「ボタン式絞り込み（チップ）」） ===== */

function hasFeature(row, name) {
  return (row.card.features ?? []).includes(name);
}

/**
 * チップの区分。同一区分内はOR、区分をまたぐとAND。
 *
 * シリアル・価格ウォッチは選択肢1つの区分（＝トグル相当）。1つの区分に
 * まとめるとAND/ORの意味が変わってしまうので、仕様どおり別の区分にしている。
 */
export const CHIP_GROUPS = Object.freeze([
  {
    id: 'tier',
    label: '層',
    options: [
      { value: 'vault', label: '金庫', test: (row) => row.card.tier === 'vault' },
      { value: 'gallery', label: 'ギャラリー', test: (row) => row.card.tier === 'gallery' },
    ],
  },
  {
    id: 'storage',
    label: '収納',
    options: [
      { value: 'magnetic', label: 'マグネット', test: (row) => row.card.storage?.type === 'magnetic' },
      { value: 'toploader', label: 'トップローダー', test: (row) => row.card.storage?.type === 'toploader' },
      { value: 'binder', label: 'バインダー', test: (row) => row.card.storage?.type === 'binder' },
    ],
  },
  {
    id: 'features',
    label: '特徴',
    options: [
      { value: 'auto', label: 'サイン', test: (row) => hasFeature(row, 'auto') },
      { value: 'patch', label: 'パッチ', test: (row) => hasFeature(row, 'patch') },
      { value: 'rookie', label: 'ルーキー', test: (row) => hasFeature(row, 'rookie') },
    ],
  },
  {
    id: 'serial',
    label: 'シリアル',
    options: [
      { value: 'has', label: 'シリアルあり', test: (row) => !isEmpty(row.card.serial) },
    ],
  },
  {
    id: 'priceWatch',
    label: '価格ウォッチ',
    options: [
      { value: 'on', label: 'watch中', test: (row) => row.card.priceWatch === true },
    ],
  },
]);

/**
 * 絞り込みの初期値。
 *
 * 層は金庫のみ（スキーマ仕様 §5-1「一覧の既定表示は tier: vault のみ」）。
 * 金庫チップを外してギャラリーだけ選べばギャラリーが見られる。
 */
export function defaultFilters() {
  return {
    tier: ['vault'],
    storage: [],
    features: [],
    serial: [],
    priceWatch: [],
    teamMode: DEFAULT_TEAM_MODE,
    teams: [],
  };
}

/** 層以外に選択があるか（「絞り込みを外す」ボタンの出し入れに使う）。 */
export function hasActiveFilters(filters) {
  const base = defaultFilters();
  return CHIP_GROUPS.some((group) => {
    const selected = filters[group.id] ?? [];
    const initial = base[group.id];
    return selected.length !== initial.length || selected.some((value) => !initial.includes(value));
  }) || (filters.teams ?? []).length > 0;
}

/**
 * チップでの絞り込み。選択が空の区分は条件なし（全件通す）。
 *
 * @param {Array} rows
 * @param {object} filters defaultFilters の形
 * @param {object|null} index buildTeamIndex の戻り値
 */
export function applyChips(rows, filters, index) {
  const active = CHIP_GROUPS
    .map((group) => ({ group, selected: filters?.[group.id] ?? [] }))
    .filter(({ selected }) => selected.length > 0)
    .map(({ group, selected }) => group.options.filter((option) => selected.includes(option.value)))
    .filter((options) => options.length > 0);

  const teamIds = filters?.teams ?? [];
  const mode = filters?.teamMode ?? DEFAULT_TEAM_MODE;

  return rows.filter((row) => {
    for (const options of active) {
      if (!options.some((option) => option.test(row))) return false;
    }
    if (teamIds.length > 0) {
      const ids = teamIdsForRow(index, row, mode);
      if (!teamIds.some((id) => ids.has(id))) return false;
    }
    return true;
  });
}
