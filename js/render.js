/**
 * DOM生成（ビュー層）。
 *
 * データからDOMを作るだけで、通信も画面状態も持たない。
 * データは必ず textContent 経由で入れる（innerHTMLは使わない）。
 */

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

export function formatPrice(price) {
  if (!price || typeof price.current !== 'number') return null;
  const yen = `¥${price.current.toLocaleString('ja-JP')}`;
  return price.checkedAt ? `${yen}（${price.checkedAt} 時点）` : yen;
}

export function formatFeature(feature) {
  return FEATURE_LABEL[feature] ?? feature;
}

export function formatStatus(status) {
  return STATUS_LABEL[status] ?? status;
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
  if (player?.nameEn) head.append(el('span', 'card__name-en', player.nameEn));
  button.append(head);

  button.append(el('p', 'card__line', joinParts([card.maker, card.series, card.season])));
  button.append(el('p', 'card__line', joinParts([
    card.variation,
    card.cardNo ? `#${card.cardNo}` : null,
    card.serial ? `シリアル ${card.serial}` : null,
  ])));
  button.append(el('p', 'card__line', joinParts([card.teamOnCard, formatStorage(card.storage)])));

  const price = formatPrice(card.price);
  button.append(price
    ? el('p', 'card__price', price)
    : el('p', 'card__price card__price--none', '価格未確認'));

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

function buildPriceSection(card, fromOverlay) {
  const section = document.createElement('section');
  section.append(el('h3', 'section-title', '価格'));

  const dl = el('dl', 'kv');
  kvRow(dl, '現在価格', typeof card.price?.current === 'number'
    ? `¥${card.price.current.toLocaleString('ja-JP')}`
    : null);
  kvRow(dl, '最終確認日', card.price?.checkedAt);
  kvRow(dl, '情報源', card.price?.source);
  kvRow(dl, '価格ウォッチ', card.priceWatch ? 'ON' : 'OFF');
  section.append(dl);

  if (fromOverlay) section.append(overlayNote('prices.json（cowork更新）の値を表示しています'));

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
 * @param {{card: object, player: object|null}} row
 * @param {{cards: Set<string>, players: Set<string>}} sources オーバーレイが当たったID
 */
export function buildDetail(row, sources) {
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
  kvRow(cardDl, 'プリント時チーム', card.teamOnCard);
  kvRow(cardDl, '層', TIER_LABEL[card.tier] ?? card.tier);
  kvRow(cardDl, '収納先', formatStorage(card.storage));
  kvRow(cardDl, '登録日', card.addedAt);
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
  kvRow(playerDl, '現所属チーム', player?.currentTeam);
  kvRow(playerDl, '引退状況', player?.status ? formatStatus(player.status) : null);
  kvRow(playerDl, '情報更新日', player?.infoUpdatedAt);
  kvRow(playerDl, '選手ID', player?.id);
  root.append(playerDl);

  if (player && sources?.players.has(player.id)) {
    root.append(overlayNote('現所属チーム・引退状況・情報更新日は players_info.json（cowork更新）の値です'));
  }

  if (!isEmpty(player?.notes)) {
    root.append(el('h3', 'section-title', '選手の備考'));
    root.append(el('p', 'notes', player.notes));
  }

  return root;
}

/* ===== 取得状況 ===== */

/** 取得状況の1行。result は {ok, sha, size} または {ok:false, error}。 */
export function buildFileStat(path, result) {
  const row = el('div', `filestat filestat--${result.ok ? 'ok' : 'ng'}`);
  row.append(el('span', 'filestat__name', path));
  if (result.ok) {
    const size = result.size.toLocaleString('ja-JP');
    row.append(el('span', 'filestat__meta', `sha ${result.sha.slice(0, 7)} / ${size} B`));
  } else {
    row.append(el('span', 'filestat__meta', '取得できず'));
    row.append(el('span', 'filestat__error', result.error.message));
  }
  return row;
}
