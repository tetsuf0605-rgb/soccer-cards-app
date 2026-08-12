/**
 * エントリポイント（フェーズ3）。
 *
 * できること: 接続設定、3ファイルの取得とオーバーレイマージ、一覧・詳細、
 * 8項目ソート、選手名検索、判定JSONの取り込み、カードの編集・登録解除・
 * priceWatch切替（いずれも collection.json へのPUT・409リトライ付き）。
 * エクスポートとオフライン閲覧はフェーズ4。
 */
import { loadSettings, saveSettings, clearSettings, isConfigured } from './config.js';
import { fetchAllFiles, commitCollection, DATA_FILES } from './github.js';
import { mergeCollection } from './merge.js';
import { buildRows, filterRows, sortRows, findSortOption, SORT_OPTIONS, DEFAULT_SORT_ID } from './query.js';
import { el, setMessage, buildCardList, buildDetail, buildFileStat } from './render.js';
import { createIngestForm } from './ingestform.js';
import { createEditForm } from './editform.js';
import { askConfirm, closeConfirm } from './confirm.js';
import { removeCard, replaceCard } from './ingest.js';

const els = {
  reload: document.getElementById('btn-reload'),
  settingsToggle: document.getElementById('btn-settings'),
  importToggle: document.getElementById('btn-import'),
  viewList: document.getElementById('view-list'),
  viewDetail: document.getElementById('view-detail'),
  viewForm: document.getElementById('view-form'),
  viewSettings: document.getElementById('view-settings'),
  search: document.getElementById('input-search'),
  sortSelect: document.getElementById('select-sort'),
  sortDir: document.getElementById('btn-sort-dir'),
  listMessage: document.getElementById('list-message'),
  cardList: document.getElementById('card-list'),
  detailBody: document.getElementById('detail-body'),
  detailMessage: document.getElementById('detail-message'),
  detailConfirm: document.getElementById('detail-confirm'),
  settingsConfirm: document.getElementById('settings-confirm'),
  edit: document.getElementById('btn-edit'),
  watch: document.getElementById('btn-watch'),
  delete: document.getElementById('btn-delete'),
  back: document.getElementById('btn-back'),
  form: document.getElementById('settings-form'),
  owner: document.getElementById('input-owner'),
  repo: document.getElementById('input-repo'),
  token: document.getElementById('input-token'),
  toggleToken: document.getElementById('btn-toggle-token'),
  clear: document.getElementById('btn-clear'),
  settingsMessage: document.getElementById('settings-message'),
  fetchStatus: document.getElementById('fetch-status'),
};

let settings = loadSettings();
let loading = false;

/** 直近の取得＋マージ結果。 */
const state = {
  /** collection.json の中身とsha。shaは書き込みの楽観ロックに使う */
  collection: null,
  /** cowork所有の2ファイル。取得できなかったものは null */
  overlays: { prices: null, playersInfo: null },
  rows: [],
  sources: { cards: new Set(), players: new Set() },
  sortId: DEFAULT_SORT_ID,
  desc: false,
  query: '',
};

/* ===== 一覧 ===== */

/** 台帳＋オーバーレイから表示用の行を作り直す。 */
function applyMerge() {
  const { merged, sources } = mergeCollection(
    state.collection?.json ?? null,
    state.overlays.prices,
    state.overlays.playersInfo,
  );
  state.rows = buildRows(merged);
  state.sources = sources;
}

function visibleRows() {
  return sortRows(filterRows(state.rows, state.query), state.sortId, state.desc);
}

function renderList() {
  const rows = visibleRows();
  els.cardList.replaceChildren(...buildCardList(rows));

  if (state.rows.length === 0) {
    setMessage(els.listMessage, 'カードが登録されていません。');
  } else if (rows.length === 0) {
    setMessage(els.listMessage, `「${state.query}」に一致する選手のカードはありません。`);
  } else if (rows.length === state.rows.length) {
    setMessage(els.listMessage, `${rows.length}枚`);
  } else {
    setMessage(els.listMessage, `${rows.length}枚 / 全${state.rows.length}枚`);
  }
}

/* ===== 読み込み ===== */

function showFetchStatus(result) {
  els.fetchStatus.replaceChildren(
    buildFileStat(DATA_FILES.collection, { ok: true, ...result.collection }),
    buildFileStat(DATA_FILES.prices, result.prices),
    buildFileStat(DATA_FILES.playersInfo, result.playersInfo),
    el('p', 'message', `最終取得: ${new Date(result.fetchedAt).toLocaleString('ja-JP')}`),
  );
}

async function load() {
  if (loading) return;

  if (!isConfigured(settings)) {
    els.cardList.replaceChildren();
    setMessage(els.listMessage, '右上の「⚙」から owner / repo / PAT を設定してください。');
    return;
  }

  loading = true;
  els.reload.disabled = true;
  setMessage(els.listMessage, '読み込み中…');

  try {
    const result = await fetchAllFiles(settings);

    state.collection = { json: result.collection.json, sha: result.collection.sha };
    // オーバーレイは取得できたものだけ重ねる（欠けても台帳は表示する）
    state.overlays = {
      prices: result.prices.ok ? result.prices.json : null,
      playersInfo: result.playersInfo.ok ? result.playersInfo.json : null,
    };
    applyMerge();

    showFetchStatus(result);
    renderList();

    // オーバーレイが欠けても台帳は表示できる。件数は残したまま警告を足す
    const missing = [
      result.prices.ok ? null : DATA_FILES.prices,
      result.playersInfo.ok ? null : DATA_FILES.playersInfo,
    ].filter(Boolean);
    if (missing.length > 0) {
      setMessage(
        els.listMessage,
        `${els.listMessage.textContent}｜${missing.join(' / ')} を取得できず、価格・所属が古い可能性があります。`,
        'error',
      );
    }
  } catch (error) {
    state.collection = null;
    state.rows = [];
    els.cardList.replaceChildren();
    setMessage(els.listMessage, error.message, 'error');
    els.fetchStatus.replaceChildren(el('p', 'message', error.message));
  } finally {
    loading = false;
    els.reload.disabled = false;
  }
}

/* ===== 画面の切り替え ===== */

function showView(name) {
  els.viewList.hidden = name !== 'list';
  els.viewDetail.hidden = name !== 'detail';
  els.viewForm.hidden = name !== 'form';
  els.viewSettings.hidden = name !== 'settings';
  els.settingsToggle.setAttribute('aria-expanded', String(name === 'settings'));
  els.importToggle.setAttribute('aria-expanded', String(name === 'form'));

  if (name === 'settings') {
    els.owner.value = settings.owner;
    els.repo.value = settings.repo;
    els.token.value = settings.token;
    setMessage(els.settingsMessage, '');
  }
  window.scrollTo(0, 0);
}

/* ===== 詳細 ===== */

/** 詳細に出している行。編集・登録解除・ウォッチ切替の対象。 */
let detailCardId = null;

function openDetail(cardId, note) {
  const row = state.rows.find((candidate) => candidate.card.id === cardId);
  if (!row) {
    // 編集の競合などで消えていたら一覧へ戻す
    detailCardId = null;
    showView('list');
    return;
  }
  detailCardId = cardId;
  closeConfirm(els.detailConfirm);
  els.detailBody.replaceChildren(buildDetail(row, state.sources));
  els.watch.textContent = row.card.priceWatch ? '価格ウォッチを外す' : '価格ウォッチに入れる';
  setMessage(els.detailMessage, note ?? '', note ? 'ok' : undefined);
  showView('detail');
}

function setDetailBusy(busy) {
  els.edit.disabled = busy;
  els.watch.disabled = busy;
  els.delete.disabled = busy;
}

/* ===== 書き込み ===== */

/**
 * collection.json を更新する。楽観ロックとリトライは github.js が持つので、
 * ここは成功したときにローカルの表示を新しい中身へ差し替えるだけ。
 */
async function commit(apply) {
  const result = await commitCollection(settings, state.collection, apply);
  state.collection = { json: result.json, sha: result.sha };
  applyMerge();
  renderList();
  return result;
}

/* ===== 取り込み ===== */

const ingestForm = createIngestForm({
  getCollection: () => state.collection,
  commit,
  onExit: (summary) => {
    showView('list');
    if (summary.saved > 0 || summary.skipped > 0) {
      const skipped = summary.skipped > 0 ? `／${summary.skipped}枚を飛ばしました` : '';
      setMessage(els.listMessage, `取り込み終了: ${summary.saved}枚を保存${skipped}`, 'ok');
    }
  },
});

function openImport() {
  if (!els.viewForm.hidden) return;
  if (!requireLoaded('取り込み')) return;

  ingestForm.open();
  showView('form');
}

/* ===== 編集・登録解除・ウォッチ切替 ===== */

const editForm = createEditForm({
  getCollection: () => state.collection,
  hasPriceOverlay: (cardId) => state.sources.cards.has(cardId),
  commit,
  onDone: (cardId, note) => openDetail(cardId, note),
});

/** 書き込み操作の前提（設定済み・台帳を読み込み済み）を確かめる。 */
function requireLoaded(action) {
  if (!isConfigured(settings)) {
    showView('settings');
    setMessage(els.settingsMessage, `${action}の前に owner / repo / PAT を設定してください。`, 'error');
    return false;
  }
  if (!state.collection) {
    showView('list');
    setMessage(els.listMessage, `${action}の前に台帳を読み込んでください（右上の ↻）。`, 'error');
    return false;
  }
  return true;
}

function openEdit() {
  if (!detailCardId || !requireLoaded('編集')) return;
  ingestForm.close();
  if (editForm.open(detailCardId)) showView('form');
}

/** 詳細画面からの1操作（切替・登録解除）を実行する。 */
async function runDetailAction(apply, note) {
  setDetailBusy(true);
  setMessage(els.detailMessage, '保存中…');
  try {
    await commit(apply);
    return true;
  } catch (error) {
    setMessage(els.detailMessage, error.message, 'error');
    return false;
  } finally {
    setDetailBusy(false);
  }
}

async function toggleWatch() {
  if (!detailCardId || !requireLoaded('価格ウォッチの切替')) return;
  const cardId = detailCardId;
  const now = new Date();

  const ok = await runDetailAction((json) => {
    const target = (json.cards ?? []).find((card) => card.id === cardId);
    if (!target) throw new Error(`${cardId} が台帳にありません。再読込してやり直してください。`);
    const next = { ...target, priceWatch: !target.priceWatch };
    return {
      json: replaceCard(json, next, now),
      message: `iphone: edit ${cardId}`,
      result: { priceWatch: next.priceWatch },
    };
  });
  if (!ok) return;

  const row = state.rows.find((candidate) => candidate.card.id === cardId);
  openDetail(cardId, row?.card.priceWatch
    ? '価格ウォッチに入れました（次回の cowork 価格チェックから更新されます）'
    : '価格ウォッチを外しました（prices.json の履歴はそのまま残ります）');
}

async function deleteCard() {
  if (!detailCardId || !requireLoaded('登録解除')) return;
  const cardId = detailCardId;
  const row = state.rows.find((candidate) => candidate.card.id === cardId);
  const label = [row?.player?.name, row?.card.series, row?.card.variation].filter(Boolean).join(' / ');

  const confirmed = await askConfirm(els.detailConfirm, {
    text: `「${label}」を倉庫へ移動（登録解除）しますか？`,
    note: 'リストからは消えますが、コミット履歴には残るので後から参照できます。',
    yesLabel: '登録解除する',
    danger: true,
  });
  if (!confirmed) return;

  const now = new Date();
  const ok = await runDetailAction((json) => ({
    json: removeCard(json, cardId, now),
    message: `iphone: delete ${cardId}`,
    result: { cardId },
  }));
  if (!ok) return;

  detailCardId = null;
  showView('list');
  setMessage(els.listMessage, `倉庫へ移動しました（${cardId}）`, 'ok');
}

/* ===== ソートUI ===== */

function fillSortOptions() {
  els.sortSelect.replaceChildren(...SORT_OPTIONS.map((option) => {
    const node = el('option', null, option.label);
    node.value = option.id;
    return node;
  }));
  els.sortSelect.value = state.sortId;
}

function updateSortDirLabel() {
  els.sortDir.textContent = state.desc ? '降順' : '昇順';
  els.sortDir.setAttribute('aria-label', `並び順: ${state.desc ? '降順' : '昇順'}（切り替え）`);
}

/* ===== イベント ===== */

els.settingsToggle.addEventListener('click', () => {
  showView(els.viewSettings.hidden ? 'settings' : 'list');
});

els.importToggle.addEventListener('click', openImport);

els.reload.addEventListener('click', () => {
  ingestForm.close();
  editForm.close();
  detailCardId = null;
  showView('list');
  load();
});

els.back.addEventListener('click', () => {
  detailCardId = null;
  closeConfirm(els.detailConfirm);
  showView('list');
});

els.edit.addEventListener('click', openEdit);
els.watch.addEventListener('click', toggleWatch);
els.delete.addEventListener('click', deleteCard);

els.cardList.addEventListener('click', (event) => {
  const button = event.target.closest('.card');
  if (button) openDetail(button.dataset.cardId);
});

els.search.addEventListener('input', () => {
  state.query = els.search.value;
  renderList();
});

els.sortSelect.addEventListener('change', () => {
  state.sortId = els.sortSelect.value;
  // 価格は「高い順」から見たいことが多いので、選び直したときに既定方向へ寄せる
  state.desc = Boolean(findSortOption(state.sortId).defaultDesc);
  updateSortDirLabel();
  renderList();
});

els.sortDir.addEventListener('click', () => {
  state.desc = !state.desc;
  updateSortDirLabel();
  renderList();
});

els.toggleToken.addEventListener('click', () => {
  const hidden = els.token.type === 'password';
  els.token.type = hidden ? 'text' : 'password';
  els.toggleToken.textContent = hidden ? '隠す' : '表示';
});

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const next = {
    owner: els.owner.value,
    repo: els.repo.value,
    token: els.token.value,
  };
  if (!next.owner.trim() || !next.repo.trim() || !next.token.trim()) {
    setMessage(els.settingsMessage, 'owner / repo / PAT をすべて入力してください。', 'error');
    return;
  }
  settings = saveSettings(next);
  showView('list');
  load();
});

els.clear.addEventListener('click', async () => {
  const confirmed = await askConfirm(els.settingsConfirm, {
    text: '保存した設定（PATを含む）をこの端末から消去しますか？',
    note: 'GitHub側のトークンは無効になりません。不要なトークンはGitHubの設定画面で失効させてください。',
    yesLabel: '消去する',
    danger: true,
  });
  if (!confirmed) return;

  clearSettings();
  settings = loadSettings();
  els.owner.value = settings.owner;
  els.repo.value = settings.repo;
  els.token.value = '';
  ingestForm.close();
  editForm.close();
  detailCardId = null;
  state.collection = null;
  state.rows = [];
  els.cardList.replaceChildren();
  els.fetchStatus.replaceChildren(el('p', 'message', 'まだ読み込んでいません。'));
  setMessage(els.settingsMessage, '消去しました。', 'ok');
});

/* ===== 起動 ===== */

fillSortOptions();
updateSortDirLabel();
showView('list');
load();

// file:// ではSWを登録できないため、http(s)配信時のみ
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('Service Workerの登録に失敗しました', error);
    });
  });
}
