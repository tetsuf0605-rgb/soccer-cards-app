/**
 * 取り込み（写真判定JSON → 台帳レコード）の純粋ロジック。
 *
 * 入力は写真判定運用仕様 §4 の受け渡しJSON。DOMもネットワークも触らない。
 * フォームの配線は ingestform.js、保存は github.js が持つ。
 *
 * 判定側は id / playerId / tier / storage / priceWatch / price / addedAt を出力しない
 * （同 §1）。それらはこのモジュールと取り込みフォームが付与する。
 */
import { foldText } from './query.js';

/** 取り込み入力の不備。メッセージはそのままユーザーに見せる。 */
export class IngestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IngestError';
  }
}

/** features のうちUIでチェックボックスにするもの。ほかは自由入力で受ける。 */
export const KNOWN_FEATURES = Object.freeze(['auto', 'patch', 'rookie']);

/** カードIDの乱数部に使う文字。 */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/* ===== 日付 ===== */

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 端末のローカル日付を YYYY-MM-DD で返す（登録日・価格確認日）。 */
export function toIsoDate(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** ローカルのオフセット付きISO時刻（例: 2026-08-12T21:30:00+09:00）。 */
export function toIsoTimestamp(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return `${toIsoDate(date)}T${clock}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/* ===== 正規化 ===== */

function toText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 空文字を null に畳む（スキーマの「読み取れない項目はnull」に合わせる）。 */
function toOptional(value) {
  return toText(value) || null;
}

/**
 * 選手名の突き合わせキー。
 * 大文字小文字・全角/半角・かな・アクセント記号・区切り記号のゆらぎを吸収する
 * （写真判定運用仕様 §5「大文字小文字・空白ゆらぎ許容」）。
 */
export function normalizeKey(text) {
  return foldText(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s.,'’`\-_/·・]/g, '');
}

/** 姓（最後のトークン）。3文字未満は当てにならないので無視する。 */
function surnameKey(nameEn) {
  const tokens = String(nameEn ?? '').trim().split(/\s+/);
  const key = normalizeKey(tokens[tokens.length - 1] ?? '');
  return key.length >= 3 ? key : '';
}

/* ===== §4 JSONの読み取り ===== */

/** ```json … ``` で囲まれていたら中身だけ取り出す（コードブロックごと貼れるように）。 */
function stripCodeFence(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return fenced ? fenced[1] : text;
}

function normalizeItem(raw, index) {
  const where = `${index + 1}件目`;
  if (!raw || typeof raw !== 'object') {
    throw new IngestError(`${where}のデータが読み取れません。`);
  }
  const card = raw.card;
  if (!card || typeof card !== 'object') {
    throw new IngestError(`${where}に card がありません。判定結果のJSONをそのまま貼り付けてください。`);
  }
  const player = raw.player && typeof raw.player === 'object' ? raw.player : {};

  return {
    card: {
      maker: toOptional(card.maker),
      series: toOptional(card.series),
      season: toOptional(card.season),
      cardNo: toOptional(card.cardNo),
      variation: toOptional(card.variation),
      serial: toOptional(card.serial),
      features: Array.isArray(card.features)
        ? card.features.map(toText).filter(Boolean)
        : [],
      teamOnCard: toOptional(card.teamOnCard),
      notes: toText(card.notes),
    },
    player: {
      name: toOptional(player.name),
      nameEn: toOptional(player.nameEn),
      nationality: toOptional(player.nationality),
      currentTeam: toOptional(player.currentTeam),
      status: toText(player.status) || 'unknown',
    },
    needsCheck: Array.isArray(raw.needsCheck) ? raw.needsCheck.map(toText).filter(Boolean) : [],
  };
}

/**
 * 貼り付けテキストを items 配列に正規化する。
 *
 * 受け付ける形（写真判定運用仕様 §4）:
 *   - { "schemaVersion": 1, "items": [ … ] } … 単体は要素1、まとめ撮りは複数
 *   - 上の items 相当の配列そのもの、または item 1件分のオブジェクト（手直し用の保険）
 *
 * @param {string} text
 * @returns {Array<{card: object, player: object, needsCheck: string[]}>}
 */
export function parseIngestJson(text) {
  const body = stripCodeFence(String(text ?? '')).trim();
  if (!body) throw new IngestError('判定結果のJSONを貼り付けてください。');

  let root;
  try {
    root = JSON.parse(body);
  } catch {
    throw new IngestError('JSONとして読めません。コードブロックの中身を丸ごと貼り付けているか確認してください。');
  }

  let items;
  if (Array.isArray(root)) items = root;
  else if (root && Array.isArray(root.items)) items = root.items;
  else if (root && typeof root === 'object' && root.card) items = [root];
  else throw new IngestError('items 配列が見つかりません。判定結果のJSONをそのまま貼り付けてください。');

  if (items.length === 0) throw new IngestError('items が空です。判定できたカードがありません。');

  return items.map(normalizeItem);
}

/* ===== 選手マッチ ===== */

/**
 * nameEn（無ければ name）で既存選手の候補を出す。
 * score 3=一致 / 2=部分一致 / 1=姓一致。呼び出し側は score===3 を既定選択にする。
 *
 * @param {Array<object>} players 既存の players 配列
 * @param {{name: string|null, nameEn: string|null}} target
 * @returns {Array<{player: object, score: number}>}
 */
export function matchPlayers(players, target) {
  const keyEn = normalizeKey(target?.nameEn);
  const keyJa = normalizeKey(target?.name);
  const surname = surnameKey(target?.nameEn);

  const scored = [];
  for (const player of players ?? []) {
    const playerEn = normalizeKey(player.nameEn);
    const playerJa = normalizeKey(player.name);

    let score = 0;
    if (keyEn && playerEn && keyEn === playerEn) score = 3;
    else if (keyJa && playerJa && keyJa === playerJa) score = 3;
    else if (keyEn && playerEn && (playerEn.includes(keyEn) || keyEn.includes(playerEn))) score = 2;
    else if (surname && surname === surnameKey(player.nameEn)) score = 1;

    if (score > 0) scored.push({ player, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/** 選手を名前で絞り込む（候補に出なかった選手を手で選ぶための検索）。 */
export function searchPlayers(players, queryText) {
  const needle = foldText(queryText).trim();
  if (!needle) return [...(players ?? [])];
  return (players ?? []).filter((player) => (
    foldText(player.name).includes(needle) || foldText(player.nameEn).includes(needle)
  ));
}

/* ===== ID採番 ===== */

/**
 * 次の選手ID（`p-0001` 形式の連番）。
 * 既存の最大値+1。欠番は埋めない（過去IDの再利用を避ける）。
 */
export function nextPlayerId(players) {
  let max = 0;
  for (const player of players ?? []) {
    const found = /^p-(\d+)$/.exec(String(player?.id ?? ''));
    if (found) max = Math.max(max, Number(found[1]));
  }
  return `p-${String(max + 1).padStart(4, '0')}`;
}

/** 既定の乱数生成。テストでは差し替える。 */
function randomChars(length) {
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => ID_ALPHABET[value % ID_ALPHABET.length]).join('');
}

/**
 * カードID `c-YYYYMMDD-乱数3桁`（スキーマ仕様 §1）。
 * 既存IDと衝突したら引き直す。
 *
 * @param {Set<string>|Array<string>} existingIds
 * @param {Date} date
 * @param {(length: number) => string} random テスト用の差し替え口
 */
export function makeCardId(existingIds, date = new Date(), random = randomChars) {
  const taken = existingIds instanceof Set ? existingIds : new Set(existingIds ?? []);
  const prefix = `c-${toIsoDate(date).replace(/-/g, '')}-`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = prefix + random(3);
    if (!taken.has(id)) return id;
  }
  throw new IngestError('カードIDを採番できませんでした。時間をおいて試してください。');
}

/* ===== 既存値の収集（オートコンプリート用） ===== */

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

/** cards から指定フィールドの既存値を重複なしで集める（datalist用）。 */
export function collectValues(cards, field) {
  const values = new Set();
  for (const card of cards ?? []) {
    const value = toText(card?.[field]);
    if (value) values.add(value);
  }
  return [...values].sort(collator.compare);
}

/** バインダー名の既存値。 */
export function collectBinderNames(cards) {
  const values = new Set();
  for (const card of cards ?? []) {
    if (card?.storage?.type === 'binder') {
      const name = toText(card.storage.name);
      if (name) values.add(name);
    }
  }
  return [...values].sort(collator.compare);
}

/* ===== レコード構築 ===== */

/**
 * フォームの入力値から players 1件を作る（キー順はスキーマ仕様 §4 の表どおり）。
 * infoUpdatedAt は cowork が書く欄なので null で置く（スキーマ仕様 §6）。
 */
export function buildPlayerRecord(id, input) {
  return {
    id,
    name: toText(input.name),
    nameEn: toText(input.nameEn),
    nationality: toText(input.nationality) || '不明',
    currentTeam: toOptional(input.currentTeam),
    status: toText(input.status) || 'unknown',
    infoUpdatedAt: null,
    notes: toText(input.notes),
  };
}

/**
 * フォームの入力値から cards 1件を作る。
 *
 * 価格を入力した場合だけ price を作る（source は "手動" 固定。写真判定運用仕様 §5）。
 * priceHistory は常に空で始める（蓄積は cowork の担当）。
 */
export function buildCardRecord(id, playerId, input, date = new Date()) {
  const price = typeof input.price === 'number' && Number.isFinite(input.price)
    ? { current: input.price, checkedAt: toIsoDate(date), source: '手動' }
    : null;

  return {
    id,
    playerId,
    maker: toText(input.maker),
    series: toText(input.series),
    season: toOptional(input.season),
    cardNo: toOptional(input.cardNo),
    variation: toText(input.variation) || 'Base',
    serial: toOptional(input.serial),
    features: [...(input.features ?? [])],
    teamOnCard: toText(input.teamOnCard),
    tier: input.tier === 'vault' ? 'vault' : 'gallery',
    storage: {
      type: input.storageType,
      name: input.storageType === 'binder' ? toText(input.storageName) : null,
    },
    priceWatch: Boolean(input.priceWatch),
    price,
    priceHistory: [],
    notes: toText(input.notes),
    addedAt: toIsoDate(date),
  };
}

/**
 * カード（＋必要なら新規選手）を足した新しい collection を返す。入力は書き換えない。
 * exportedAt は書き出した時刻に更新する。
 *
 * @param {object} collection
 * @param {{card: object, player?: object|null}} addition
 * @param {Date} date
 */
export function addToCollection(collection, { card, player }, date = new Date()) {
  return {
    ...collection,
    exportedAt: toIsoTimestamp(date),
    players: player ? [...(collection.players ?? []), player] : [...(collection.players ?? [])],
    cards: [...(collection.cards ?? []), card],
  };
}

/** players / cards を差し替えた新しい collection（exportedAt も更新する）。 */
function withLists(collection, players, cards, date) {
  return { ...collection, exportedAt: toIsoTimestamp(date), players, cards };
}

/**
 * 同じIDのカードを置き換えた新しい collection を返す。
 * 409で取り直したあとに対象が消えていることがあるので、無ければ例外にする。
 */
export function replaceCard(collection, card, date = new Date()) {
  const cards = collection.cards ?? [];
  const index = cards.findIndex((candidate) => candidate.id === card.id);
  if (index < 0) {
    throw new IngestError(`${card.id} が台帳にありません。再読込してやり直してください。`);
  }
  const next = [...cards];
  next[index] = card;
  return withLists(collection, [...(collection.players ?? [])], next, date);
}

/**
 * カードを取り除いた新しい collection（UIの「倉庫へ移動（登録解除）」）。
 * 選手レコードは残す（スキーマ仕様 §5: 再昇格時に選手IDを維持できる）。
 */
export function removeCard(collection, cardId, date = new Date()) {
  const cards = collection.cards ?? [];
  const next = cards.filter((card) => card.id !== cardId);
  if (next.length === cards.length) {
    throw new IngestError(`${cardId} が台帳にありません。再読込してやり直してください。`);
  }
  return withLists(collection, [...(collection.players ?? [])], next, date);
}

/** 選手を1人足した新しい collection（編集画面での紐づけ替え＋新規作成）。 */
export function addPlayerToCollection(collection, player, date = new Date()) {
  return withLists(
    collection,
    [...(collection.players ?? []), player],
    [...(collection.cards ?? [])],
    date,
  );
}

/** 同じIDの選手を置き換えた新しい collection（表記の修正用）。 */
export function replacePlayer(collection, player, date = new Date()) {
  const players = collection.players ?? [];
  const index = players.findIndex((candidate) => candidate.id === player.id);
  if (index < 0) {
    throw new IngestError(`${player.id} が台帳にありません。再読込してやり直してください。`);
  }
  const next = [...players];
  next[index] = player;
  return withLists(collection, next, [...(collection.cards ?? [])], date);
}

/**
 * 表記（iPhoneが直してよい欄）だけを差し替えた選手レコード。
 * currentTeam / status / infoUpdatedAt は cowork 所有なので触らない（スキーマ仕様 §6）。
 *
 * @returns {object|null} 変更がなければ null
 */
export function retypePlayer(player, input) {
  const next = {
    ...player,
    name: toText(input.name),
    nameEn: toText(input.nameEn),
    nationality: toText(input.nationality) || '不明',
    notes: toText(input.notes),
  };
  const changed = ['name', 'nameEn', 'nationality', 'notes']
    .some((field) => next[field] !== player[field]);
  return changed ? next : null;
}

/**
 * 台帳のカード → フォームの入力値。
 * 価格は台帳側の値を出す（表示はオーバーレイ優先だが、直せるのは台帳側だけ）。
 */
export function valuesFromCard(card) {
  return {
    maker: card.maker ?? '',
    series: card.series ?? '',
    season: card.season ?? '',
    cardNo: card.cardNo ?? '',
    variation: card.variation ?? '',
    serial: card.serial ?? '',
    features: [...(card.features ?? [])],
    teamOnCard: card.teamOnCard ?? '',
    tier: card.tier ?? 'gallery',
    storageType: card.storage?.type ?? 'binder',
    storageName: card.storage?.name ?? '',
    priceWatch: Boolean(card.priceWatch),
    price: typeof card.price?.current === 'number' ? card.price.current : undefined,
    notes: card.notes ?? '',
  };
}

/**
 * 既存カードに編集結果を当てた新しいカード（id / playerId 以外を入力値で作り直す）。
 *
 * 価格は、値が変わったときだけ 手動・当日 で書き換える。変えていなければ
 * 既存の checkedAt / source を残す（cowork が入れた出所を消さない）。
 * priceHistory は cowork の担当なのでそのまま持ち越す。
 */
export function applyCardEdit(card, playerId, input, date = new Date()) {
  const next = buildCardRecord(card.id, playerId, input, date);
  next.priceHistory = [...(card.priceHistory ?? [])];
  next.addedAt = card.addedAt ?? next.addedAt;

  const before = typeof card.price?.current === 'number' ? card.price.current : null;
  const after = typeof next.price?.current === 'number' ? next.price.current : null;
  if (before !== null && after !== null && before === after) next.price = { ...card.price };

  return next;
}
