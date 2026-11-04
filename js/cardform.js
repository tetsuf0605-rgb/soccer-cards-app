/**
 * 取り込みと編集で共用するカードフォーム。
 *
 * このモジュールが持つのは「フォームというUI部品」だけ。何のために保存するか
 * （取り込み＝ingestform.js / 編集＝editform.js）は呼び出し側が決める。
 * 同じ入力欄を使い回すので、項目の並びも検証も1か所にまとまる。
 *
 * 選手欄で直せるのは表記（name / nameEn / nationality / notes）まで。
 * currentTeam / status / infoUpdatedAt は cowork 所有なので、新規作成のときだけ
 * 暫定値として入力できる（スキーマ仕様 §6・写真判定運用仕様 §4）。
 */
import { el, setMessage } from './render.js';
import { KNOWN_FEATURES, collectBinderNames, collectValues, searchPlayers } from './ingest.js';

/** 「新規選手として登録する」を表す選択値。選手IDと衝突しない値にする。 */
export const NEW_PLAYER = '__new__';

/** needsCheck の項目名 → 画面での呼び名。 */
const CHECK_LABEL = {
  serial: 'シリアル',
  variation: 'バリエーション',
  series: 'シリーズ',
  maker: 'メーカー',
  season: 'シーズン',
  cardNo: 'カード番号',
  teamOnCard: 'プリント時チーム',
  name: '名前（カナ）',
  nameEn: 'カード表記',
  nationality: '国籍',
  features: '特徴',
};

const STATUS_LABEL = { active: '現役', retired: '引退', unknown: '不明' };

const els = {
  form: document.getElementById('card-form'),
  // 貼り付け欄は同じビューにあるが、使うのは取り込みモードだけ
  paste: document.getElementById('import-paste'),
  progress: document.getElementById('form-progress'),
  message: document.getElementById('form-message'),
  save: document.getElementById('btn-form-save'),
  skip: document.getElementById('btn-form-skip'),
  cancel: document.getElementById('btn-form-cancel'),
  back: document.getElementById('btn-form-back'),

  playerRead: document.getElementById('ig-player-read'),
  playerChoices: document.getElementById('ig-player-choices'),
  playerSearch: document.getElementById('ig-player-search'),
  playerFields: document.getElementById('ig-player-fields'),
  playerFieldsNote: document.getElementById('ig-player-fields-note'),
  playerProvisional: document.getElementById('ig-player-provisional'),
  pName: document.getElementById('ig-p-name'),
  pNameEn: document.getElementById('ig-p-nameen'),
  pNationality: document.getElementById('ig-p-nationality'),
  pNotes: document.getElementById('ig-p-notes'),
  pTeam: document.getElementById('ig-p-team'),
  pStatus: document.getElementById('ig-p-status'),

  maker: document.getElementById('ig-maker'),
  series: document.getElementById('ig-series'),
  variation: document.getElementById('ig-variation'),
  team: document.getElementById('ig-team'),
  season: document.getElementById('ig-season'),
  cardNo: document.getElementById('ig-cardno'),
  serial: document.getElementById('ig-serial'),
  serialOk: document.getElementById('ig-serial-ok'),
  featOther: document.getElementById('ig-feat-other'),
  notes: document.getElementById('ig-notes'),

  tier: document.getElementById('ig-tier'),
  tierField: document.getElementById('ig-tier-field'),
  tierNote: document.getElementById('ig-tier-note'),
  storageType: document.getElementById('ig-storage-type'),
  storageBinder: document.getElementById('ig-storage-binder'),
  storageNameField: document.getElementById('ig-storage-name-field'),
  storageName: document.getElementById('ig-storage-name'),
  priceWatch: document.getElementById('ig-pricewatch'),
  gbRef: document.getElementById('ig-gbref'),
  gbRefNote: document.getElementById('ig-gbref-note'),
  price: document.getElementById('ig-price'),
  priceNote: document.getElementById('ig-price-note'),

  lists: {
    maker: document.getElementById('list-maker'),
    series: document.getElementById('list-series'),
    variation: document.getElementById('list-variation'),
    teamOnCard: document.getElementById('list-team'),
    season: document.getElementById('list-season'),
    binder: document.getElementById('list-binder'),
    nationality: document.getElementById('list-nationality'),
  },
};

const featureBoxes = {
  auto: document.getElementById('ig-feat-auto'),
  patch: document.getElementById('ig-feat-patch'),
  rookie: document.getElementById('ig-feat-rookie'),
};

const state = {
  mode: 'ingest',
  choice: NEW_PLAYER,
  /** 候補として最初に並べる選手 */
  candidates: [],
  /** 選び直しの検索対象（台帳の全選手） */
  players: [],
  /** 新規作成を選んだときに入れ直す下書き（判定の読み取り結果） */
  draft: null,
  /** バリエーションの補助候補（既存の登録値）。チェックリストが来たら後ろへ回す */
  variationFallback: [],
  /** シリアルの再確認が要るかの判定に使う、開いた時点の値 */
  originalSerial: '',
};

/** 開いているフロー（取り込み or 編集）のボタン処理。 */
let handlers = {};

/* ===== 表示 ===== */

/** 貼り付け欄は「取り込みモードで、まだフォームを出していないとき」だけ出す。 */
function syncPaste() {
  els.paste.hidden = !(state.mode === 'ingest' && els.form.hidden);
}

/**
 * モードごとのボタン文言。
 *   ingest    … 写真判定JSONからの取り込み（登録経路A）
 *   checklist … チェックリストからの登録（登録経路B。写真判定運用仕様 §8）
 *   edit      … 既存カードの編集
 */
const MODE_LABELS = {
  ingest: { save: '保存する', cancel: '取り込みを中止', back: '← 一覧へ' },
  checklist: { save: 'この内容で登録する', cancel: '登録をやめる', back: '← 製品へ' },
  edit: { save: '変更を保存', cancel: '編集をやめる', back: '← 詳細へ' },
};

function labelsFor(mode) {
  return MODE_LABELS[mode] ?? MODE_LABELS.ingest;
}

/**
 * ボタンの文言と、モードでしか使わない部品の出し入れ。
 *
 * 新規登録（ingest / checklist）では層を選ばせず常に金庫、収納はマグネット/
 * トップローダーの2択（写真判定運用仕様 §7-1・スキーマ仕様 §5-1）。編集では
 * 既存のギャラリー・バインダーのカードを扱うので、どちらも選べるようにする（同 §5-2）。
 */
export function setMode(mode) {
  state.mode = mode;
  const isNew = mode !== 'edit';
  const labels = labelsFor(mode);

  // 「この1枚を飛ばす」は、複数枚を順に見る取り込みだけのもの
  els.skip.hidden = mode !== 'ingest';
  els.save.textContent = labels.save;
  els.cancel.textContent = labels.cancel;
  els.back.textContent = labels.back;

  els.tierField.hidden = isNew;
  els.tierNote.hidden = !isNew;
  els.storageBinder.hidden = isNew;
  els.storageBinder.disabled = isNew;

  syncPaste();
}

/**
 * gbRef の選択肢を入れ替える（gb/ のファイル一覧。スキーマ仕様 §9-4）。
 * まだ1件も無ければ「指定しない」だけにして、理由を注記に出す。
 *
 * @param {Array<{key: string}>} entries listJsonDirectory の結果
 */
export function setGbOptions(entries) {
  const keys = (entries ?? []).map((entry) => entry.key);
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '指定しない';

  els.gbRef.replaceChildren(none, ...keys.map((key) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = key;
    return option;
  }));

  els.gbRef.disabled = keys.length === 0;
  els.gbRefNote.textContent = keys.length === 0
    ? 'gb/ にまだ登録がありません（段階3で作ります）。'
    : 'GBで引いたカードは、該当のブレイクを選ぶと gb/ と結び付きます。';
}

function fillDatalist(node, values) {
  node.replaceChildren(...values.map((value) => {
    const option = document.createElement('option');
    option.value = value;
    return option;
  }));
}

/**
 * 既存の登録値をオートコンプリートに流し込む（表記寄せ。写真判定運用仕様 §5）。
 *
 * チームは teams.json の正式名も候補に入れる。teamOnCard / currentTeam は
 * 正式名に寄せる決まりなので（スキーマ仕様 §4）、まだ1枚も持っていないチームでも
 * 正式名を選べるほうが揺れが出ない。
 *
 * @param {object|null} collection
 * @param {object|null} [teamIndex] buildTeamIndex の戻り値
 */
export function refreshDatalists(collection, teamIndex) {
  const cards = collection?.cards ?? [];
  for (const field of ['maker', 'series', 'season']) {
    fillDatalist(els.lists[field], collectValues(cards, field));
  }

  const teamNames = new Set(collectValues(cards, 'teamOnCard'));
  for (const team of teamIndex?.teams ?? []) teamNames.add(team.name);
  fillDatalist(els.lists.teamOnCard, [...teamNames].sort(new Intl.Collator('en').compare));

  fillDatalist(els.lists.binder, collectBinderNames(cards));
  fillDatalist(els.lists.nationality, collectValues(collection?.players ?? [], 'nationality'));

  // 既存値を覚えておく。チェックリストが届いたら、その前に差し込む
  state.variationFallback = collectValues(cards, 'variation');
  fillDatalist(els.lists.variation, state.variationFallback);
}

/**
 * バリエーションの候補を、製品のチェックリスト優先で並べ直す
 * （写真判定運用仕様 §7-1「製品のチェックリスト（variations[].name）を第一候補、
 * 既存登録値を補助候補」）。
 *
 * チェックリストの取得は非同期なので、フォームを開いたあとから差し替わることがある。
 *
 * @param {string[]} names チェックリストの variations[].name
 */
export function setVariationOptions(names) {
  const ordered = [...(names ?? [])];
  const seen = new Set(ordered);
  for (const value of state.variationFallback) {
    if (!seen.has(value)) ordered.push(value);
  }
  fillDatalist(els.lists.variation, ordered);
}

function clearChecks() {
  for (const field of els.form.querySelectorAll('[data-check]')) {
    field.classList.remove('field--check');
  }
}

function markChecks(names) {
  clearChecks();
  for (const name of names ?? []) {
    const field = els.form.querySelector(`[data-check="${CSS.escape(name)}"]`);
    if (field) field.classList.add('field--check');
  }
}

/** needsCheck を画面の呼び名にして並べる（進捗行に出す）。 */
export function describeChecks(names) {
  return (names ?? []).map((name) => CHECK_LABEL[name] ?? name).join(' / ');
}

/* ===== 選手の選択 ===== */

function playerSummary(player) {
  return [player.nameEn, player.currentTeam, STATUS_LABEL[player.status] ?? player.status]
    .filter(Boolean)
    .join(' ・ ');
}

function buildChoice(value, main, sub, checked) {
  const label = el('label', 'choice');
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'ig-player';
  radio.value = value;
  radio.checked = checked;
  label.append(radio);

  const body = el('span', 'choice__body');
  body.append(el('span', 'choice__main', main));
  if (sub) body.append(el('span', 'choice__sub', sub));
  label.append(body);
  return label;
}

/** 候補ラジオを描き直す。listed を渡すと候補の代わりにそれを並べる。 */
function renderChoices(listed) {
  const shown = listed ?? state.candidates;
  const nodes = shown.slice(0, 20).map((player) => buildChoice(
    player.id,
    player.name || player.nameEn || player.id,
    playerSummary(player),
    state.choice === player.id,
  ));

  if (listed && shown.length === 0) {
    nodes.push(el('p', 'hint', '一致する登録済み選手がいません。'));
  }
  nodes.push(buildChoice(
    NEW_PLAYER,
    '新規選手として登録する',
    '下の欄に入力した内容で選手を作ります',
    state.choice === NEW_PLAYER,
  ));
  els.playerChoices.replaceChildren(...nodes);
}

function findPlayer(id) {
  return state.players.find((player) => player.id === id) ?? null;
}

/** 選択に合わせて選手欄の中身と見出しを入れ替える。 */
function syncPlayerFields() {
  const isNew = state.choice === NEW_PLAYER;
  els.playerProvisional.hidden = !isNew;

  const source = isNew ? state.draft : findPlayer(state.choice);
  els.pName.value = source?.name ?? '';
  els.pNameEn.value = source?.nameEn ?? '';
  els.pNationality.value = source?.nationality ?? '';
  els.pNotes.value = source?.notes ?? '';
  if (isNew) {
    els.pTeam.value = state.draft?.currentTeam ?? '';
    els.pStatus.value = STATUS_LABEL[state.draft?.status] ? state.draft.status : 'unknown';
  }

  els.playerFieldsNote.textContent = isNew
    ? '新規選手として登録する内容です。'
    : '表記を直すとこの選手のレコードも更新します（所属・引退状況は cowork が管理するため触りません）。';
}

/* ===== 開く ===== */

/**
 * フォームを開く（内容を入れ替える）。
 *
 * @param {object} options
 * @param {'ingest'|'edit'} options.mode
 * @param {string} options.progress 進捗行の文言
 * @param {object} options.values カード欄の値（ingest.valuesFromCard 形式）
 * @param {Array<object>} options.players 台帳の全選手（選び直しの検索対象）
 * @param {Array<object>} options.candidates 最初に並べる候補
 * @param {string} options.choice 初期選択（選手ID or NEW_PLAYER）
 * @param {object|null} options.draft 新規作成を選んだときに入れる下書き
 * @param {string} options.playerRead 選手欄の先頭に出す注記
 * @param {string[]} options.needsCheck 強調する項目
 * @param {string|null} options.priceNote 価格欄に出す注記
 */
export function fill(options) {
  setMode(options.mode);
  setMessage(els.message, '');

  state.players = options.players ?? [];
  state.candidates = options.candidates ?? [];
  state.choice = options.choice ?? NEW_PLAYER;
  state.draft = options.draft ?? null;

  els.progress.textContent = options.progress ?? '';
  els.playerRead.textContent = options.playerRead ?? '';
  els.playerSearch.value = '';
  renderChoices();
  syncPlayerFields();
  markChecks(options.needsCheck);

  const values = options.values;
  els.maker.value = values.maker ?? '';
  els.series.value = values.series ?? '';
  els.variation.value = values.variation ?? '';
  els.team.value = values.teamOnCard ?? '';
  els.season.value = values.season ?? '';
  els.cardNo.value = values.cardNo ?? '';
  els.serial.value = values.serial ?? '';
  els.serialOk.checked = false;
  els.notes.value = values.notes ?? '';
  state.originalSerial = els.serial.value.trim();

  const features = values.features ?? [];
  for (const [name, box] of Object.entries(featureBoxes)) box.checked = features.includes(name);
  els.featOther.value = features.filter((name) => !KNOWN_FEATURES.includes(name)).join(', ');

  // 新規登録は常に金庫。編集では台帳の値をそのまま出す
  els.tier.value = options.mode === 'edit' ? (values.tier ?? 'vault') : 'vault';
  els.storageType.value = values.storageType ?? 'toploader';
  els.storageName.value = values.storageName ?? '';
  els.priceWatch.checked = Boolean(values.priceWatch);
  els.price.value = typeof values.price === 'number' ? String(values.price) : '';
  syncGbRef(values.gbRef ?? '');
  syncStorageName();

  els.priceNote.textContent = options.priceNote ?? '';
  els.priceNote.hidden = !options.priceNote;

  els.form.hidden = false;
  syncPaste();
  window.scrollTo(0, 0);
}

function syncStorageName() {
  els.storageNameField.hidden = els.storageType.value !== 'binder';
}

/**
 * gbRef に値を入れる。
 *
 * 台帳に入っている break_id が gb/ の一覧に無いこともある（GBの定義ファイルを
 * まだ作っていない場合）。そのときは選択肢に足してから選ぶ — 編集で保存した
 * だけで値が消えるのを防ぐ。
 */
function syncGbRef(value) {
  if (value && !Array.from(els.gbRef.options).some((option) => option.value === value)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${value}（gb/ に未登録）`;
    els.gbRef.append(option);
  }
  els.gbRef.value = value;
  // 値が入っているなら、gb/ が空でも選び直せるようにしておく
  els.gbRef.disabled = els.gbRef.options.length <= 1;
}

export function hide() {
  els.form.hidden = true;
  clearChecks();
  setMessage(els.message, '');
  syncPaste();
}

export function isOpen() {
  return !els.form.hidden;
}

/** 保存中はボタンを止める（二重送信の防止）。 */
export function setBusy(busy) {
  els.save.disabled = busy;
  els.skip.disabled = busy;
  els.save.textContent = busy ? '保存中…' : labelsFor(state.mode).save;
}

export function message(text, kind) {
  setMessage(els.message, text, kind);
}

/** ボタン操作の受け手を差し替える（開いているフローが受け取る）。 */
export function attach(next) {
  handlers = next ?? {};
}

/* ===== 読み取り ===== */

function readFeatures() {
  const checked = KNOWN_FEATURES.filter((name) => featureBoxes[name].checked);
  const extra = els.featOther.value
    .split(/[,、]/)
    .map((value) => value.trim())
    .filter((value) => value && !checked.includes(value));
  return [...checked, ...extra];
}

function invalid(message, node) {
  setMessage(els.message, message, 'error');
  if (node) {
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: 'center' });
  }
  return { error: message };
}

/**
 * 入力を検証して取り出す。
 * @returns {{value: object}|{error: string}}
 */
export function read() {
  const isNew = state.choice === NEW_PLAYER;
  if (!isNew && !findPlayer(state.choice)) {
    return invalid('紐づけ先の選手が見つかりません。もう一度選び直してください。', els.playerSearch);
  }
  if (!els.pName.value.trim()) return invalid('選手の名前（カナ）を入力してください。', els.pName);
  if (!els.pNameEn.value.trim()) return invalid('選手のカード表記（nameEn）を入力してください。', els.pNameEn);

  if (!els.maker.value.trim()) return invalid('メーカーを入力してください。', els.maker);
  if (!els.series.value.trim()) return invalid('シリーズを入力してください。', els.series);
  if (!els.team.value.trim()) return invalid('プリント時チームを入力してください。', els.team);

  // 写真判定運用仕様 §5・§8-3: シリアルは「実物と一致」チェックなしでは保存できない
  // （チェックリスト登録でも目視確認は必須）。編集では、シリアルを変えたときだけ
  // 確認を求める（登録時に一度確認済みのため）
  const serial = els.serial.value.trim();
  const needsSerialCheck = serial && (state.mode !== 'edit' || serial !== state.originalSerial);
  if (needsSerialCheck && !els.serialOk.checked) {
    return invalid('シリアルが実物と一致することを確認してチェックを入れてください。', els.serialOk);
  }

  if (els.storageType.value === 'binder' && !els.storageName.value.trim()) {
    return invalid('バインダー名を入力してください。', els.storageName);
  }

  let price;
  const priceText = els.price.value.trim();
  if (priceText) {
    price = Number(priceText);
    if (!Number.isFinite(price) || price < 0) {
      return invalid('価格は0以上の数字で入力してください。', els.price);
    }
  }

  return {
    value: {
      choice: state.choice,
      isNew,
      player: {
        name: els.pName.value,
        nameEn: els.pNameEn.value,
        nationality: els.pNationality.value,
        notes: els.pNotes.value,
        currentTeam: isNew ? els.pTeam.value : null,
        status: isNew ? els.pStatus.value : 'unknown',
      },
      card: {
        maker: els.maker.value,
        series: els.series.value,
        season: els.season.value,
        cardNo: els.cardNo.value,
        variation: els.variation.value,
        serial: els.serial.value,
        features: readFeatures(),
        teamOnCard: els.team.value,
        // 新規登録では選ばせないので、フォームの値ではなく固定値を返す
        tier: state.mode === 'edit' ? els.tier.value : 'vault',
        storageType: els.storageType.value,
        storageName: els.storageName.value,
        priceWatch: els.priceWatch.checked,
        gbRef: els.gbRef.value,
        price,
        notes: els.notes.value,
      },
    },
  };
}

/* ===== イベント ===== */

els.playerChoices.addEventListener('change', (event) => {
  if (event.target.name !== 'ig-player') return;
  state.choice = event.target.value;
  syncPlayerFields();
});

els.playerSearch.addEventListener('input', () => {
  const text = els.playerSearch.value.trim();
  renderChoices(text ? searchPlayers(state.players, text) : null);
});

els.storageType.addEventListener('change', syncStorageName);

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  handlers.onSave?.();
});

els.skip.addEventListener('click', () => handlers.onSkip?.());
els.cancel.addEventListener('click', () => handlers.onCancel?.());
els.back.addEventListener('click', () => handlers.onBack?.());
