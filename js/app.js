/**
 * エントリポイント（フェーズ0）。
 *
 * できること: 接続設定の保存、3ファイルの取得、collection.json の素表示。
 * マージ表示・ソート・検索はフェーズ1、取り込みと保存はフェーズ2で追加する。
 */
import { loadSettings, saveSettings, clearSettings, isConfigured } from './config.js';
import { fetchAllFiles, DATA_FILES } from './github.js';
import { el, setMessage, buildCardList, buildFileStat } from './render.js';

const els = {
  reload: document.getElementById('btn-reload'),
  settingsToggle: document.getElementById('btn-settings'),
  viewList: document.getElementById('view-list'),
  viewSettings: document.getElementById('view-settings'),
  listMessage: document.getElementById('list-message'),
  cardList: document.getElementById('card-list'),
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

/* ===== 読み込み ===== */

function showFetchStatus(result) {
  const rows = [
    buildFileStat(DATA_FILES.collection, { ok: true, ...result.collection }),
    buildFileStat(DATA_FILES.prices, result.prices),
    buildFileStat(DATA_FILES.playersInfo, result.playersInfo),
    el('p', 'message', `最終取得: ${new Date(result.fetchedAt).toLocaleString('ja-JP')}`),
  ];
  els.fetchStatus.replaceChildren(...rows);
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
    const { nodes, cardCount, playerCount } = buildCardList(result.collection.json);
    els.cardList.replaceChildren(...nodes);
    showFetchStatus(result);

    setMessage(els.listMessage, cardCount === 0
      ? 'カードが登録されていません。'
      : `${cardCount}枚 / 選手${playerCount}人`);

    // オーバーレイが欠けても台帳は表示できるが、気づけるように知らせる
    const missing = [
      result.prices.ok ? null : DATA_FILES.prices,
      result.playersInfo.ok ? null : DATA_FILES.playersInfo,
    ].filter(Boolean);
    if (missing.length > 0) {
      setMessage(
        els.listMessage,
        `${missing.join(' / ')} を取得できませんでした。詳細は設定画面の「取得状況」を確認してください。`,
        'error',
      );
    }
  } catch (error) {
    els.cardList.replaceChildren();
    setMessage(els.listMessage, error.message, 'error');
    els.fetchStatus.replaceChildren(el('p', 'message', error.message));
  } finally {
    loading = false;
    els.reload.disabled = false;
  }
}

/* ===== 画面の切り替え ===== */

function showSettings(show) {
  els.viewSettings.hidden = !show;
  els.viewList.hidden = show;
  els.settingsToggle.setAttribute('aria-expanded', String(show));
  if (show) {
    els.owner.value = settings.owner;
    els.repo.value = settings.repo;
    els.token.value = settings.token;
    setMessage(els.settingsMessage, '');
  }
  window.scrollTo(0, 0);
}

/* ===== イベント ===== */

els.settingsToggle.addEventListener('click', () => {
  showSettings(els.viewSettings.hidden);
});

els.reload.addEventListener('click', () => {
  if (!els.viewSettings.hidden) showSettings(false);
  load();
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
  showSettings(false);
  load();
});

els.clear.addEventListener('click', () => {
  if (!window.confirm('保存した設定（PATを含む）を消去します。よろしいですか？')) return;
  clearSettings();
  settings = loadSettings();
  els.owner.value = settings.owner;
  els.repo.value = settings.repo;
  els.token.value = '';
  els.cardList.replaceChildren();
  els.fetchStatus.replaceChildren(el('p', 'message', 'まだ読み込んでいません。'));
  setMessage(els.settingsMessage, '消去しました。', 'ok');
});

/* ===== 起動 ===== */

showSettings(false);
load();

// file:// ではSWを登録できないため、http(s)配信時のみ
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('Service Workerの登録に失敗しました', error);
    });
  });
}
