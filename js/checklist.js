/**
 * チェックリスト（スキーマ仕様 §9-3）と所持照合（同 §10）の純粋ロジック。
 *
 * DOMもネットワークも触らない。画面は checklistview.js、取得は github.js が持つ。
 *
 * productKey はチェックリストと台帳をつなぐ唯一の鍵で、ファイル名そのものでもある。
 * 生成規則は仕様に明記がないため、§9-3 のサンプル
 * （Topps / "Topps Chrome UEFA Club Competitions" / 2025-26
 *   → 2025-26-topps-chrome-uefa-club-competitions）を再現する形で決めた:
 *
 *   {season}-{maker}-{series} をスラグ化し、series が maker で始まるときは
 *   maker を重ねない。
 *
 * 同じ規則を dev/checklist_import.py にも置いてある（両方を直すこと）。
 */
import { foldText, matchKey } from './text.js';

/* ===== productKey ===== */

/**
 * ファイル名に使える形に落とす。
 * NFKC → 小文字 → アクセント除去 → 英数字以外をハイフンに畳む。
 */
export function slug(text) {
  return foldText(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * productKey を作る。season が無いカードは照合できないので null を返す
 * （スキーマ仕様 §10-1「season が null・表記ゆれのカードは productKey が一致しない」）。
 *
 * @param {string|null} maker
 * @param {string|null} series
 * @param {string|null} season
 * @returns {string|null}
 */
export function productKeyOf(maker, series, season) {
  const seasonSlug = slug(season);
  const seriesSlug = slug(series);
  if (!seasonSlug || !seriesSlug) return null;

  const makerSlug = slug(maker);
  // 「Topps」＋「Topps Chrome ...」で topps が二度出ないようにする
  const needsMaker = makerSlug
    && seriesSlug !== makerSlug
    && !seriesSlug.startsWith(`${makerSlug}-`);

  return [seasonSlug, needsMaker ? makerSlug : null, seriesSlug].filter(Boolean).join('-');
}

/** 台帳のカード1枚から productKey を引く。 */
export function productKeyOfCard(card) {
  return productKeyOf(card?.maker, card?.series, card?.season);
}

/* ===== チェックリストの読み取り ===== */

/** cards[].kind の語彙（スキーマ仕様 §9-3）。 */
export const CARD_KINDS = Object.freeze(['base', 'insert', 'auto', 'relic', 'other']);

const KIND_LABEL = {
  base: 'ベース',
  insert: 'インサート',
  auto: 'オート',
  relic: 'レリック',
  other: 'その他',
};

export function kindLabel(kind) {
  return KIND_LABEL[kind] ?? kind ?? '';
}

/**
 * チェックリストJSONを扱いやすい形に整える（壊れていても落ちない）。
 *
 * @param {object|null} json checklists/{productKey}.json
 * @returns {{productKey: string, maker: string, series: string, season: string,
 *            schemaVersion: number, coverage: string, cardsCoverage: string,
 *            confirmedAt: string|null, sources: string[],
 *            variations: Array<object>, cards: Array<object>}}
 */
export function readChecklist(json) {
  const variations = Array.isArray(json?.variations)
    ? json.variations.filter((item) => item && typeof item.name === 'string' && item.name)
    : [];
  const cards = Array.isArray(json?.cards)
    ? json.cards.filter((item) => item && typeof item.cardNo === 'string' && item.cardNo)
    : [];

  return {
    schemaVersion: Number(json?.schemaVersion) || 1,
    productKey: json?.productKey ?? '',
    maker: json?.maker ?? '',
    series: json?.series ?? '',
    season: json?.season ?? '',
    coverage: json?.coverage ?? 'unknown',
    // schemaVersion 1 は cards[] を持たない形式（§9-3）
    cardsCoverage: json?.cardsCoverage ?? (cards.length > 0 ? 'unknown' : 'none'),
    confirmedAt: json?.confirmedAt ?? null,
    sources: Array.isArray(json?.sources) ? json.sources.filter(Boolean) : [],
    variations,
    cards,
  };
}

/**
 * 判定チャットの冒頭に貼るためのパラレル一覧（写真判定運用仕様 §7-3）。
 * variations[] だけを抜いた JSON 文字列を返す。
 */
export function parallelsClipboardText(checklist) {
  return `${JSON.stringify({
    productKey: checklist.productKey,
    maker: checklist.maker,
    series: checklist.series,
    season: checklist.season,
    coverage: checklist.coverage,
    variations: checklist.variations,
  }, null, 2)}\n`;
}

/**
 * cards[] の1行に存在しうるパラレル名（スキーマ仕様 §9-3）。
 *
 * `"all"` は variations[] の category が base / parallel のもの全部という意味。
 * インサート・オートは個別に列挙された配列をそのまま使う。
 */
export function applicableVariations(checklist, row) {
  if (row?.parallels === 'all') {
    return checklist.variations
      .filter((variation) => variation.category === 'base' || variation.category === 'parallel')
      .map((variation) => variation.name);
  }
  if (Array.isArray(row?.parallels)) return row.parallels.filter(Boolean);
  return [];
}

/* ===== 所持照合（スキーマ仕様 §10） ===== */

/** 照合結果の区分。強い順に並べてある（行のまとめにそのまま使う）。 */
export const MATCH_STATUS = Object.freeze(['owned', 'otherParallel', 'candidate', 'missing']);

const STATUS_LABEL = {
  owned: '所持',
  otherParallel: '別パラレル所持',
  candidate: '候補あり',
  missing: '未所持',
};

export function statusLabel(status) {
  return STATUS_LABEL[status] ?? status;
}

/** cardNo の突き合わせキー（大文字小文字無視・空白除去。§10-1）。 */
export function cardNoKey(cardNo) {
  return foldText(cardNo).replace(/\s+/g, '');
}

/**
 * 台帳の行を productKey → cardNoキー → 行 の索引にする。
 *
 * @param {Array} rows buildRows の結果（card と player を持つ行）
 * @returns {Map<string, Map<string, Array>>}
 */
export function indexOwnedByProduct(rows) {
  const index = new Map();
  for (const row of rows ?? []) {
    const productKey = productKeyOfCard(row.card);
    if (!productKey) continue;
    const key = cardNoKey(row.card.cardNo);
    if (!key) continue;

    if (!index.has(productKey)) index.set(productKey, new Map());
    const byCardNo = index.get(productKey);
    if (!byCardNo.has(key)) byCardNo.set(key, []);
    byCardNo.get(key).push(row);
  }
  return index;
}

/** variation が未確定（null・空）の所持カードか（§10-2「候補あり」）。 */
function isUndecided(card) {
  const variation = foldText(card?.variation).trim();
  return variation === '';
}

/**
 * チェックリストの1行を台帳と突き合わせる。
 *
 * パラレルごとに区分を出し、行全体の区分はその中でいちばん強いものにする。
 * 「所持」が1つでもあれば行は所持、無ければ別パラレル所持 → 候補あり → 未所持。
 *
 * @param {object} checklist readChecklist の結果
 * @param {object} row checklist.cards[] の1件
 * @param {Array} owned 同じ cardNo を持つ台帳の行（indexOwnedByProduct から引く）
 * @returns {{status: string, owned: Array, byVariation: Array<{name: string, status: string, rows: Array}>,
 *            nameMismatch: boolean}}
 */
export function matchRow(checklist, row, owned) {
  const hits = owned ?? [];
  const names = applicableVariations(checklist, row);

  const undecided = hits.filter((hit) => isUndecided(hit.card));
  const byVariation = names.map((name) => {
    const key = matchKey(name);
    const sameVariation = hits.filter((hit) => matchKey(hit.card.variation) === key);

    let status = 'missing';
    if (sameVariation.length > 0) status = 'owned';
    else if (undecided.length > 0) status = 'candidate';
    else if (hits.length > 0) status = 'otherParallel';

    return { name, status, rows: sameVariation };
  });

  // 行のまとめ。パラレルが1つも定義されていない行は、所持の有無だけで決める
  let status = 'missing';
  if (byVariation.length === 0) {
    if (hits.length > 0) status = undecided.length === hits.length ? 'candidate' : 'owned';
  } else {
    status = MATCH_STATUS.find((candidate) => byVariation.some((entry) => entry.status === candidate))
      ?? 'missing';
  }

  // nameEn は補助。cardNo が同じで名前が違うならデータ品質を疑う（§10-1）
  const rowKey = matchKey(row.nameEn);
  const nameMismatch = Boolean(rowKey) && hits.length > 0
    && hits.every((hit) => {
      const playerKey = matchKey(hit.player?.nameEn);
      return playerKey && playerKey !== rowKey;
    });

  return { status, owned: hits, byVariation, nameMismatch };
}

/**
 * チェックリスト全体を照合する。
 *
 * @param {object} checklist readChecklist の結果
 * @param {Array} rows buildRows の結果（全カード）
 * @returns {{entries: Array<{row: object, match: object}>, counts: Record<string, number>}}
 */
export function matchChecklist(checklist, rows) {
  const byCardNo = indexOwnedByProduct(rows).get(checklist.productKey) ?? new Map();

  const entries = checklist.cards.map((row) => ({
    row,
    match: matchRow(checklist, row, byCardNo.get(cardNoKey(row.cardNo))),
  }));

  const counts = Object.fromEntries(MATCH_STATUS.map((status) => [status, 0]));
  for (const entry of entries) counts[entry.match.status] += 1;

  return { entries, counts };
}

/**
 * チェックリスト登録（写真判定運用仕様 §8）でフォームに入れる初期値を作る。
 *
 * 入力させるのは serial / storage / priceWatch / notes / gbRef だけで、
 * 製品とカードの同定ぶんはここで埋める。tier は vault 固定（スキーマ仕様 §5-1）。
 *
 * @param {object} checklist readChecklist の結果
 * @param {object} row checklist.cards[] の1件
 * @param {string} variation 選んだパラレル名
 * @returns {{values: object, sourceChecklist: {productKey: string, cardNo: string}}}
 */
export function valuesFromChecklistRow(checklist, row, variation) {
  // 複数選手カードは メイン選手を nameEn にし、他選手は備考へ回す（§8-3）
  const others = Array.isArray(row.nameEnOthers) ? row.nameEnOthers.filter(Boolean) : [];
  const notes = [
    row.notes,
    others.length > 0 ? `他の選手: ${others.join(' / ')}` : null,
  ].filter(Boolean).join('\n');

  return {
    values: {
      maker: checklist.maker,
      series: checklist.series,
      season: checklist.season,
      cardNo: row.cardNo,
      variation,
      serial: '',
      features: [...(row.features ?? [])],
      teamOnCard: row.team ?? '',
      tier: 'vault',
      storageType: 'toploader',
      storageName: '',
      priceWatch: true,
      gbRef: '',
      notes,
    },
    sourceChecklist: { productKey: checklist.productKey, cardNo: row.cardNo },
  };
}
