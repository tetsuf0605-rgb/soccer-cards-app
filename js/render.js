/**
 * DOM生成（ビュー層）。
 *
 * データからDOMを作るだけで、通信も画面状態も持たない。
 * フェーズ1でソート・検索・マージ表示を足すときもここに閉じる。
 *
 * データは必ず textContent 経由で入れる（innerHTMLは使わない）。
 */

const TIER_LABEL = { gallery: 'ギャラリー', vault: '金庫' };
const STORAGE_LABEL = {
  magnetic: 'マグネットローダー',
  toploader: 'トップローダー',
  binder: 'バインダー',
};

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

/** 空要素を除いて「・」で連結する。 */
function joinParts(parts) {
  return parts.filter((part) => part !== null && part !== undefined && part !== '').join('・');
}

/** カード1枚分の <li>。 */
export function buildCard(card, playersById) {
  const player = playersById.get(card.playerId);
  const li = el('li', 'card');

  const head = el('div', 'card__head');
  head.append(el('span', 'card__name', player?.name ?? '（選手データなし）'));
  if (player?.nameEn) head.append(el('span', 'card__name-en', player.nameEn));
  li.append(head);

  li.append(el('p', 'card__line', joinParts([card.maker, card.series, card.season])));
  li.append(el('p', 'card__line', joinParts([
    card.variation,
    card.cardNo ? `#${card.cardNo}` : null,
    card.serial ? `シリアル ${card.serial}` : null,
  ])));
  li.append(el('p', 'card__line', joinParts([card.teamOnCard, formatStorage(card.storage)])));

  const price = formatPrice(card.price);
  li.append(price
    ? el('p', 'card__price', price)
    : el('p', 'card__price card__price--none', '価格未確認'));

  const badges = el('div', 'badges');
  badges.append(el(
    'span',
    `badge badge--${card.tier === 'vault' ? 'vault' : 'gallery'}`,
    TIER_LABEL[card.tier] ?? card.tier,
  ));
  for (const feature of card.features ?? []) badges.append(el('span', 'badge', feature));
  if (card.priceWatch) badges.append(el('span', 'badge badge--watch', '価格ウォッチ'));
  li.append(badges);

  return li;
}

/**
 * collection.json から一覧のDOMを組み立てる。
 * @returns {{nodes: HTMLElement[], cardCount: number, playerCount: number}}
 */
export function buildCardList(collectionJson) {
  const players = Array.isArray(collectionJson?.players) ? collectionJson.players : [];
  const cards = Array.isArray(collectionJson?.cards) ? collectionJson.cards : [];
  const playersById = new Map(players.map((player) => [player.id, player]));

  return {
    nodes: cards.map((card) => buildCard(card, playersById)),
    cardCount: cards.length,
    playerCount: players.length,
  };
}

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
