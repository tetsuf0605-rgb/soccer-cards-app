/**
 * DOM生成（ビュー層）。
 *
 * データからDOMを作るだけで、通信も画面状態も持たない。
 * データは必ず textContent 経由で入れる（innerHTMLは使わない）。
 */
import { ageFromBirthDate } from './query.js';
import { formatCareerEntry, resolveTeam, teamLabel } from './refdata.js';

const TIER_LABEL = { gallery: 'ギャラリー', vault: '金庫' };
const STORAGE_LABEL = {
  magnetic: 'マグネットローダー',
  toploader: 'トップローダー',
  binder: 'バインダー',
};
const STATUS_LABEL = { active: '現役', retired: '引退', unknown: '不明' };
const FEATURE_LABEL = { auto: 'サイン', patch: 'パッチ', rookie: 'ルーキー' };

const PLACEHOLDER = '—';

/** 要素を1つ作る。 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** メッセージ領域を書き換える。kind は 'error' / 'ok' / 未指定。 */
export function setMessage(node, text, kind) {
  node.className = 'message';
  if (kind) node.classList.add(`message--${kind}`);
  node.textContent = text ?? '';
}

function isEmpty(value) {
  return value === null || value === undefined || value === '';
}

export function formatStorage(storage) {
  if (!storage || !storage.type) return '収納先 未設定';
  const base = STORAGE_LABEL[storage.type] ?? storage.type;
  return storage.name ? `${base}（${storage.name}）` : base;
}

export function formatYen(value) {
  return typeof value === 'number' ? `¥${value.toLocaleString('ja-JP')}` : null;
}

export function formatPrice(price) {
  if (!price || typeof price.current !== 'number') return null;
  const yen = formatYen(price.current);
  return price.checkedAt ? `${yen}（${price.checkedAt} 時点）` : yen;
}

/** 推定の出し方（スキーマ仕様 §9-7）。 */
const METHOD_LABEL = {
  exact: '同一カードの実測の中央値',
  model: '選手基準×係数',
  fallback: '同製品の他選手で代用',
};

export function formatMethod(method) {
  return METHOD_LABEL[method] ?? method ?? '';
}

/**
 * 推定価格の表示文（スキーマ仕様 §9-7）。
 *
 * 信頼度 高・中 は value を、低 は「low〜high」の幅だけを出す。
 * 幅を出せない（low/high が無い）低信頼は、やむをえず value を出す。
 */
export function formatEstimate(estimate) {
  if (!estimate || typeof estimate !== 'object') return null;

  if (estimate.confidence === '低') {
    const low = formatYen(estimate.low);
    const high = formatYen(estimate.high);
    if (low && high) return `${low}〜${high}`;
  }
  return formatYen(estimate.value);
}

/**
 * 一覧・詳細に出す価格の1行。実測があれば実測、無ければ推定（スキーマ仕様 §9-7）。
 *
 * @param {object} card マージ済みのカード
 * @returns {{kind: 'measured'|'estimate'|'none', text: string}}
 */
export function priceLine(card) {
  const measured = formatPrice(card?.price);
  if (measured) return { kind: 'measured', text: measured };

  const estimate = formatEstimate(card?.estimate);
  if (estimate) return { kind: 'estimate', text: `推定 ${estimate}` };

  return { kind: 'none', text: '価格未確認' };
}

export function formatFeature(feature) {
  return FEATURE_LABEL[feature] ?? feature;
}

export function formatStatus(status) {
  return STATUS_LABEL[status] ?? status;
}

/**
 * 年齢の表示文（スキーマ仕様 §1。birthDate から表示時に算出する）。
 * birthDate が無い選手は null を返し、呼び出し側で出さない／「—」にする。
 */
export function formatAge(birthDate) {
  const age = ageFromBirthDate(birthDate);
  return age === null ? null : `${age}歳`;
}

/** 空要素を除いて「・」で連結する。 */
function joinParts(parts) {
  return parts.filter((part) => !isEmpty(part)).join('・');
}

function tierBadge(tier) {
  return el('span', `badge badge--${tier === 'vault' ? 'vault' : 'gallery'}`, TIER_LABEL[tier] ?? tier);
}

/* ===== 一覧 ===== */

/** カード1枚分の <li>。中身は詳細を開くボタン。 */
export function buildCard(row) {
  const { card, player } = row;
  const li = el('li');
  const button = el('button', 'card');
  button.type = 'button';
  button.dataset.cardId = card.id;

  const head = el('div', 'card__head');
  head.append(el('span', 'card__name', player?.name ?? '（選手データなし）'));
  const age = formatAge(player?.birthDate);
  if (player?.nameEn || age) {
    head.append(el('span', 'card__name-en', joinParts([player?.nameEn, age])));
  }
  button.append(head);

  button.append(el('p', 'card__line', joinParts([card.maker, card.series, card.season])));
  button.append(el('p', 'card__line', joinParts([
    card.variation,
    card.cardNo ? `#${card.cardNo}` : null,
    card.serial ? `シリアル ${card.serial}` : null,
  ])));
  button.append(el('p', 'card__line', joinParts([card.teamOnCard, formatStorage(card.storage)])));

  const price = priceLine(card);
  button.append(el('p', `card__price card__price--${price.kind}`, price.text));

  const badges = el('div', 'badges');
  badges.append(tierBadge(card.tier));
  for (const feature of card.features ?? []) badges.append(el('span', 'badge', formatFeature(feature)));
  if (card.priceWatch) badges.append(el('span', 'badge badge--watch', '価格ウォッチ'));
  button.append(badges);

  li.append(button);
  return li;
}

/**
 * 並び替え・絞り込み済みの行から一覧を組み立てる。
 * @param {Array} rows
 * @returns {HTMLElement[]}
 */
export function buildCardList(rows) {
  return rows.map(buildCard);
}

/* ===== 詳細 ===== */

function kvRow(dl, label, value) {
  dl.append(el('dt', null, label));
  dl.append(el('dd', null, isEmpty(value) ? PLACEHOLDER : String(value)));
}

/** オーバーレイ由来であることを示す小さな注記。 */
function overlayNote(text) {
  return el('p', 'overlay-note', text);
}

/**
 * チーム名の表示。teams.json に載っていれば日本語名を添える
 * （照合はすべて正式名でしているので、出すときだけ読みやすくする）。
 */
function formatTeam(name, index) {
  if (isEmpty(name)) return null;
  const team = index ? resolveTeam(index, name) : null;
  const label = teamLabel(team);
  return label && label !== name ? `${name}（${label}）` : name;
}

function buildPriceSection(card, fromOverlay) {
  const section = document.createElement('section');
  section.append(el('h3', 'section-title', '価格'));

  const dl = el('dl', 'kv');
  kvRow(dl, '現在価格', formatYen(card.price?.current));
  kvRow(dl, '最終確認日', card.price?.checkedAt);
  kvRow(dl, '情報源', card.price?.source);
  kvRow(dl, '価格ウォッチ', card.priceWatch ? 'ON' : 'OFF');
  section.append(dl);

  if (fromOverlay) section.append(overlayNote('prices.json（cowork更新）の値を表示しています'));

  // 推定価格（スキーマ仕様 §9-7）。実測とは別物だと分かるように節を分ける
  if (card.estimate && typeof card.estimate === 'object') {
    const measured = typeof card.price?.current === 'number';
    section.append(el('h3', 'section-title', '推定価格'));

    const estimateDl = el('dl', 'kv');
    kvRow(estimateDl, '推定', formatEstimate(card.estimate));
    kvRow(estimateDl, '信頼度', card.estimate.confidence);
    kvRow(estimateDl, '出し方', formatMethod(card.estimate.method));
    kvRow(estimateDl, '推定日', card.estimate.estimatedAt);
    section.append(estimateDl);

    if (!isEmpty(card.estimate.basis)) {
      section.append(el('p', 'notes notes--basis', card.estimate.basis));
    }
    section.append(el('p', 'estimate-note', measured
      ? '実測があるので、一覧には実測を出しています。'
      : '実測がないため、一覧にはこの推定を「推定」と付けて出しています。'));
  }

  const history = card.priceHistory ?? [];
  if (history.length > 0) {
    section.append(el('h3', 'section-title', `価格履歴（${history.length}件）`));
    const list = el('ul', 'history');
    // 新しいものを上に。元配列は末尾追記なので反転して見せる
    for (const entry of [...history].reverse()) {
      const item = el('li', 'history__item');
      // 並びは [日付] [情報源] …… [価格]（価格を右端に揃える）
      item.append(el('span', 'history__date', entry.date ?? PLACEHOLDER));
      item.append(el('span', 'history__source', entry.source ?? ''));
      item.append(el('span', 'history__price', typeof entry.price === 'number'
        ? `¥${entry.price.toLocaleString('ja-JP')}`
        : PLACEHOLDER));
      list.append(item);
    }
    section.append(list);
  }
  return section;
}

/**
 * カード詳細のDOM。
 * @param {{card: object, player: object|null, career: Array<object>|null}} row
 * @param {{cards: Set<string>, players: Set<string>}} sources オーバーレイが当たったID
 * @param {object|null} [index] teams.json の索引（チーム名の日本語表示と在籍履歴に使う）
 */
export function buildDetail(row, sources, index) {
  const { card, player } = row;
  const root = el('div', 'detail');

  const head = el('div', 'detail__head');
  head.append(el('h2', 'detail__name', player?.name ?? '（選手データなし）'));
  if (player?.nameEn) head.append(el('p', 'detail__name-en', player.nameEn));
  root.append(head);

  const badges = el('div', 'badges');
  badges.append(tierBadge(card.tier));
  for (const feature of card.features ?? []) badges.append(el('span', 'badge', formatFeature(feature)));
  if (card.priceWatch) badges.append(el('span', 'badge badge--watch', '価格ウォッチ'));
  root.append(badges);

  root.append(buildPriceSection(card, sources?.cards.has(card.id)));

  root.append(el('h3', 'section-title', 'カード'));
  const cardDl = el('dl', 'kv');
  kvRow(cardDl, 'メーカー', card.maker);
  kvRow(cardDl, 'シリーズ', card.series);
  kvRow(cardDl, 'シーズン', card.season);
  kvRow(cardDl, 'カード番号', card.cardNo);
  kvRow(cardDl, 'バリエーション', card.variation);
  kvRow(cardDl, 'シリアル', card.serial);
  kvRow(cardDl, '特徴', (card.features ?? []).map(formatFeature).join('・'));
  kvRow(cardDl, 'プリント時チーム', formatTeam(card.teamOnCard, index));
  kvRow(cardDl, '層', TIER_LABEL[card.tier] ?? card.tier);
  kvRow(cardDl, '収納先', formatStorage(card.storage));
  kvRow(cardDl, '登録日', card.addedAt);
  // v1.4新設。GBで入手したカードと、チェックリスト登録で作ったカードの出自
  kvRow(cardDl, 'GB（入手元）', card.gbRef);
  kvRow(cardDl, 'チェックリスト登録', card.sourceChecklist
    ? `${card.sourceChecklist.productKey ?? ''} #${card.sourceChecklist.cardNo ?? ''}`.trim()
    : null);
  kvRow(cardDl, 'カードID', card.id);
  root.append(cardDl);

  if (!isEmpty(card.notes)) {
    root.append(el('h3', 'section-title', 'カードの備考'));
    root.append(el('p', 'notes', card.notes));
  }

  root.append(el('h3', 'section-title', '選手'));
  const playerDl = el('dl', 'kv');
  kvRow(playerDl, '名前', player?.name);
  kvRow(playerDl, 'カード表記', player?.nameEn);
  kvRow(playerDl, '国籍', player?.nationality);
  kvRow(playerDl, '生年月日', player?.birthDate);
  kvRow(playerDl, '年齢', formatAge(player?.birthDate));
  kvRow(playerDl, '現所属チーム', formatTeam(player?.currentTeam, index));
  kvRow(playerDl, '引退状況', player?.status ? formatStatus(player.status) : null);
  kvRow(playerDl, '情報更新日', player?.infoUpdatedAt);
  kvRow(playerDl, '選手ID', player?.id);
  root.append(playerDl);

  if (player && sources?.players.has(player.id)) {
    root.append(overlayNote('生年月日・現所属チーム・引退状況・情報更新日は players_info.json（cowork更新）の値です'));
  }

  // 在籍履歴（スキーマ仕様 §9-5）。players_info.json にある選手だけ出る
  if (Array.isArray(row.career) && row.career.length > 0) {
    root.append(el('h3', 'section-title', `在籍履歴（${row.career.length}件）`));
    const list = el('ul', 'career');
    // 新しいものを上に（配列は古い順に並んでいる）
    for (const entry of [...row.career].reverse()) {
      list.append(el('li', 'career__item', formatCareerEntry(entry, index)));
    }
    root.append(list);
    root.append(overlayNote('在籍履歴は players_info.json（cowork更新）の値です'));
  }

  if (!isEmpty(player?.notes)) {
    root.append(el('h3', 'section-title', '選手の備考'));
    root.append(el('p', 'notes', player.notes));
  }

  return root;
}

/* ===== 取得状況 ===== */

/**
 * 取得状況の1行。
 * result は {ok, sha, size} / {ok:true, missing:true} / {ok:false, error}。
 */
export function buildFileStat(path, result) {
  const row = el('div', `filestat filestat--${result.ok ? 'ok' : 'ng'}`);
  row.append(el('span', 'filestat__name', path));
  if (result.missing) {
    // 参照データは未作成のことがある（保存同期方式仕様 §4）。エラーにしない
    row.append(el('span', 'filestat__meta', '未作成（空として扱います）'));
  } else if (result.ok) {
    const size = (result.size ?? 0).toLocaleString('ja-JP');
    row.append(el('span', 'filestat__meta', `sha ${result.sha.slice(0, 7)} / ${size} B`));
  } else {
    row.append(el('span', 'filestat__meta', '取得できず'));
    row.append(el('span', 'filestat__error', result.error.message));
  }
  return row;
}

/** 参照データのディレクトリ1行。result は {ok, entries} または {ok:false, error}。 */
export function buildDirStat(path, result) {
  const row = el('div', `filestat filestat--${result.ok ? 'ok' : 'ng'}`);
  row.append(el('span', 'filestat__name', `${path}/`));
  if (result.ok) {
    const count = result.entries?.length ?? 0;
    row.append(el('span', 'filestat__meta', count === 0 ? '未作成・0件' : `${count}件`));
  } else {
    row.append(el('span', 'filestat__meta', '取得できず'));
    row.append(el('span', 'filestat__error', result.error.message));
  }
  return row;
}
