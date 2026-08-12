/**
 * エントリポイント（フェーズ1）。
 *
 * できること: 接続設定、3ファイルの取得とオーバーレイマージ、一覧・詳細、
 * 8項目ソート、選手名検索。
 * 取り込みと保存はフェーズ2、編集はフェーズ3、エクスポートはフェーズ4。
 */
import { loadSettings, saveSettings, clearSettings, isConfigured } from './config.js';
import { fetchAllFiles, DATA_FILES } from './github.js';
import { mergeCollection } from './merge.js';
import { buildRows, filterRows, sortRows, findSortOption, SORT_OPTIONS, DEFAULT_SORT_ID } from './query.js';
import { el, setMessage, buildCardList, buildDetail, buildFileStat } from './render.js';

const els = {
  reload: document.getElementById('btn-reload'),
  settingsToggle: document.getElementById('btn-settings'),
  viewList: document.getElementById('view-list'),
  viewDetail: document.getElementById('view-detail'),
  viewSettings: document.getElementById('view-settings'),
  search: document.getElementById('input-search'),
  sortSelect: document.getElementById('select-sort'),
  sortDir: document.getElementById('btn-sort-dir'),
  listMessage: document.getElementById('list-message'),
  cardList: document.getElementById('card-list'),
  detailBody: document.getElementById('detail-body'),
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
  rows: [],
  sources: { cards: new Set(), players: new Set() },
  sortId: DEFAULT_SORT_ID,
  desc: false,
  query: '',
};

/* ===== 一覧 ===== */

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

    // オーバーレイは取得できたものだけ重ねる（欠けても台帳は表示する）
    const { merged, sources } = mergeCollection(
      result.collection.json,
      result.prices.ok ? result.prices.json : null,
      result.playersInfo.ok ? result.playersInfo.json : null,
    );
    state.rows = buildRows(merged);
    state.sources = sources;

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
  els.viewSettings.hidden = name !== 'settings';
  els.settingsToggle.setAttribute('aria-expanded', String(name === 'settings'));

  if (name === 'settings') {
    els.owner.value = settings.owner;
    els.repo.value = settings.repo;
    els.token.value = settings.token;
    setMessage(els.settingsMessage, '');
  }
  window.scrollTo(0, 0);
}

function openDetail(cardId) {
  const row = state.rows.find((candidate) => candidate.card.id === cardId);
  if (!row) return;
  els.detailBody.replaceChildren(buildDetail(row, state.sources));
  showView('detail');
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

els.reload.addEventListener('click', () => {
  showView('list');
  load();
});

els.back.addEventListener('click', () => showView('list'));

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

els.clear.addEventListener('click', () => {
  if (!window.confirm('保存した設定（PATを含む）を消去します。よろしいですか？')) return;
  clearSettings();
  settings = loadSettings();
  els.owner.value = settings.owner;
  els.repo.value = settings.repo;
  els.token.value = '';
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
