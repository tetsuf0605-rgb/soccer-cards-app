/**
 * エントリポイント。
 *
 * できること: 接続設定、データ3ファイル＋参照データの取得とオーバーレイマージ、
 * 一覧・詳細、9項目ソート、フリーワード検索、チップ絞り込み、チームテーマ、
 * 狙い選手（targets.json）の編集、判定JSONの取り込み、カードの編集・登録解除・
 * priceWatch切替（いずれも collection.json へのPUT・409リトライ付き）、
 * マージ済みcollection.jsonのエクスポート、最終取得データのオフライン閲覧。
 */
import { loadSettings, saveSettings, clearSettings, isConfigured } from './config.js';
import {
  fetchAllFiles, getJsonFile, commitCollection, commitTargets as commitTargetsFile,
  checklistPath, gbPath, DATA_FILES, REF_FILES, REF_DIRS,
} from './github.js';
import { mergeCollection } from './merge.js';
import {
  buildRows, filterRows, applyChips, sortRows, findSortOption, effectivePrice,
  defaultFilters, SORT_OPTIONS, DEFAULT_SORT_ID,
} from './query.js';
import {
  buildTeamIndex, readTargets, addTarget, removeTarget, targetableFromRow,
} from './refdata.js';
import { matchKey } from './text.js';
import { readChecklist } from './checklist.js';
import { el, setMessage, buildCardList, buildDetail, buildFileStat, buildDirStat } from './render.js';
import { createIngestForm } from './ingestform.js';
import { createEditForm } from './editform.js';
import { createFilterBar } from './chips.js';
import { createTargetsView } from './targets.js';
import { createLibrary } from './library.js';
import { createChecklistForm } from './checklistform.js';
import { setGbOptions } from './cardform.js';
import { applyTeamTheme } from './theme.js';
import { askConfirm, closeConfirm } from './confirm.js';
import { removeCard, replaceCard, toIsoDate, toIsoTimestamp } from './ingest.js';
import { loadSnapshot, saveSnapshot, clearSnapshot } from './cache.js';
import { buildExport, canShareFile, shareFile, downloadFile } from './export.js';

/** targets.json が未作成のときの土台（初回PUTはこれに1件足したものになる）。 */
const EMPTY_TARGETS = { schemaVersion: 1, targets: [] };

const els = {
  reload: document.getElementById('btn-reload'),
  settingsToggle: document.getElementById('btn-settings'),
  importToggle: document.getElementById('btn-import'),
  targetsToggle: document.getElementById('btn-targets'),
  targetsBack: document.getElementById('btn-targets-back'),
  libraryToggle: document.getElementById('btn-library'),
  libraryBack: document.getElementById('btn-library-back'),
  checklistBack: document.getElementById('btn-checklist-back'),
  gbBack: document.getElementById('btn-gb-back'),
  viewList: document.getElementById('view-list'),
  viewDetail: document.getElementById('view-detail'),
  viewForm: document.getElementById('view-form'),
  viewTargets: document.getElementById('view-targets'),
  viewLibrary: document.getElementById('view-library'),
  viewChecklist: document.getElementById('view-checklist'),
  viewGb: document.getElementById('view-gb'),
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
  detailTarget: document.getElementById('btn-detail-target'),
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
  offlineBanner: document.getElementById('offline-banner'),
  exportDownload: document.getElementById('btn-export'),
  exportShare: document.getElementById('btn-export-share'),
  exportMessage: document.getElementById('export-message'),
};

let settings = loadSettings();
let loading = false;

/** 直近の取得＋マージ結果。 */
const state = {
  /** collection.json の中身とsha。shaは書き込みの楽観ロックに使う */
  collection: null,
  /** cowork所有の2ファイル。取得できなかったものは null */
  overlays: { prices: null, playersInfo: null },
  /**
   * 参照データ（スキーマ仕様 §9）。collection.json にはマージしない。
   * teams / targets は中身とsha、checklists / gb はファイル一覧だけ持つ。
   */
  refs: { teams: null, targets: null, checklists: [], gb: [] },
  /**
   * 最後に開いた製品・GBの中身（保存同期方式仕様 §4）。
   * ディレクトリの一覧と違い、中身は開いたときに個別GETする
   */
  cache: { checklist: null, gb: null },
  /** teams.json の索引。取得前・未作成でも使える空の索引で始める */
  teamIndex: buildTeamIndex(null),
  rows: [],
  sources: { cards: new Set(), players: new Set() },
  sortId: DEFAULT_SORT_ID,
  desc: false,
  query: '',
  /** チップ絞り込みの状態。既定はギャラリー非表示（スキーマ仕様 §5-1） */
  filters: defaultFilters(),
  /** 表示中のデータをGitHubから取れた時刻（ISO）。キャッシュ表示のときは取得当時の時刻 */
  fetchedAt: '',
  /**
   * 表示中のデータがこのセッションでGitHubから取れたものか。
   * false＝キャッシュ表示。書き込みは常にこれが true のときだけ許す
   * （保存同期方式仕様 §4「登録・編集はオンライン時のみ」）
   */
  fresh: false,
};

/* ===== 一覧 ===== */

/** 台帳＋オーバーレイから表示用の行を作り直す。 */
function applyMerge() {
  const { merged, sources, career } = mergeCollection(
    state.collection?.json ?? null,
    state.overlays.prices,
    state.overlays.playersInfo,
  );
  state.rows = buildRows(merged, career);
  state.sources = sources;
}

/** 参照データから索引を作り直す（teams.json / gb の一覧が差し替わったとき）。 */
function applyRefs() {
  state.teamIndex = buildTeamIndex(state.refs.teams?.json ?? null);
  setGbOptions(state.refs.gb);
}

/** フリーワード検索だけを当てた行。 */
function searchedRows() {
  return filterRows(state.rows, state.query, state.teamIndex);
}

/**
 * チーム以外の条件を当てた行。
 * チップに出すチームと枚数はこれを母集団にして数える（いま見ている条件の中で
 * どのチームが何枚あるか、が分かるように）。
 */
function facetRows() {
  return applyChips(searchedRows(), { ...state.filters, teams: [] }, state.teamIndex);
}

function visibleRows() {
  const filtered = applyChips(searchedRows(), state.filters, state.teamIndex);
  return sortRows(filtered, state.sortId, state.desc);
}

/**
 * チームを1つだけ選んでいる間は、そのチームのテーマに切り替える
 * （スキーマ仕様 §1。複数選択時・未選択時は既定テーマ）。
 */
function syncTeamTheme() {
  const selected = state.filters.teams ?? [];
  const team = selected.length === 1 ? state.teamIndex.byId.get(selected[0]) : null;
  applyTeamTheme(team ?? null);
}

/** チップ絞り込みのUI。状態はこのモジュールが持ち、描画と操作だけ任せる。 */
const filterBar = createFilterBar({
  getFilters: () => state.filters,
  getTeamIndex: () => state.teamIndex,
  getFacetRows: facetRows,
  onChange: (next) => {
    state.filters = next;
    renderList();
  },
  onReset: () => {
    state.filters = defaultFilters();
    renderList();
  },
});

function renderList() {
  const rows = visibleRows();
  els.cardList.replaceChildren(...buildCardList(rows));
  filterBar.render();
  syncTeamTheme();

  if (state.rows.length === 0) {
    setMessage(els.listMessage, 'カードが登録されていません。');
  } else if (rows.length === 0) {
    setMessage(els.listMessage, state.query
      ? `「${state.query}」と絞り込みに一致するカードはありません。`
      : '絞り込みに一致するカードはありません。');
  } else if (rows.length === state.rows.length) {
    setMessage(els.listMessage, `${rows.length}枚${priceSortNote(rows)}`);
  } else {
    setMessage(els.listMessage, `${rows.length}枚 / 全${state.rows.length}枚${priceSortNote(rows)}`);
  }
}

/**
 * 価格で並べているとき、実測がないカードが推定で並んでいることを添える
 * （スキーマ仕様 §9-7。prices.json はほとんどが推定だけのエントリ）。
 */
function priceSortNote(rows) {
  if (state.sortId !== 'price') return '';
  const estimated = rows.filter((row) => effectivePrice(row.card).source === 'estimate').length;
  return estimated > 0 ? `｜うち${estimated}枚は推定で並べています` : '';
}

/* ===== 読み込み ===== */

function formatFetchedAt(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '不明' : date.toLocaleString('ja-JP');
}

function showFetchStatus(result) {
  els.fetchStatus.replaceChildren(
    buildFileStat(DATA_FILES.collection, { ok: true, ...result.collection }),
    buildFileStat(DATA_FILES.prices, result.prices),
    buildFileStat(DATA_FILES.playersInfo, result.playersInfo),
    buildFileStat(REF_FILES.teams, result.teams),
    buildFileStat(REF_FILES.targets, result.targets),
    buildDirStat(REF_DIRS.checklists, result.checklists),
    buildDirStat(REF_DIRS.gb, result.gb),
    el('p', 'message', `最終取得: ${formatFetchedAt(result.fetchedAt)}`),
  );
}

/** いまの取得内容をオフライン閲覧用に取り置く。 */
function persistSnapshot() {
  return saveSnapshot(settings, {
    collection: state.collection,
    overlays: state.overlays,
    refs: state.refs,
    cache: state.cache,
    fetchedAt: state.fetchedAt,
  });
}

/**
 * 保存済みキャッシュを画面に出す（起動時と、取得に失敗したとき）。
 * @returns {boolean} 出せたら true
 */
function showSnapshot() {
  if (!isConfigured(settings)) return false;
  const snapshot = loadSnapshot(settings);
  if (!snapshot) return false;

  state.collection = snapshot.collection;
  state.overlays = snapshot.overlays;
  state.refs = snapshot.refs ?? { teams: null, targets: null, checklists: [], gb: [] };
  state.cache = snapshot.cache ?? { checklist: null, gb: null };
  state.fetchedAt = snapshot.fetchedAt;
  state.fresh = false;
  applyMerge();
  applyRefs();
  renderList();
  updateWriteAvailability();
  return true;
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
    // 参照データは未作成（404）でも ok: true・空の中身で返ってくる
    state.refs = {
      teams: result.teams.ok ? { json: result.teams.json, sha: result.teams.sha } : null,
      targets: result.targets.ok ? { json: result.targets.json, sha: result.targets.sha } : null,
      checklists: result.checklists.ok ? result.checklists.entries : [],
      gb: result.gb.ok ? result.gb.entries : [],
    };
    state.fetchedAt = result.fetchedAt;
    state.fresh = true;
    applyMerge();
    applyRefs();

    showFetchStatus(result);
    renderList();
    updateWriteAvailability();

    // オフライン閲覧用に取り置く。落ちても今の表示には影響しない
    const cached = persistSnapshot();
    if (!cached) {
      // 黙って落とすとオフラインで開けない理由が分からなくなる
      els.fetchStatus.append(el('p', 'message message--error',
        'この端末に保存できませんでした（容量不足など）。オフラインでは閲覧できません。'));
    }

    // オーバーレイが欠けても台帳は表示できる。件数は残したまま警告を足す
    const missing = [
      result.prices.ok ? null : DATA_FILES.prices,
      result.playersInfo.ok ? null : DATA_FILES.playersInfo,
      result.teams.ok ? null : REF_FILES.teams,
    ].filter(Boolean);
    if (missing.length > 0) {
      setMessage(
        els.listMessage,
        `${els.listMessage.textContent}｜${missing.join(' / ')} を取得できず、価格・所属・チーム絞り込みが欠けている可能性があります。`,
        'error',
      );
    }
  } catch (error) {
    // 取得できなくても、前に読めた内容があるなら閲覧だけは続けられるようにする
    state.fresh = false;
    const restored = showSnapshot();
    if (!restored) {
      state.collection = null;
      state.rows = [];
      els.cardList.replaceChildren();
    }
    setMessage(
      els.listMessage,
      restored
        ? `${error.message}｜${formatFetchedAt(state.fetchedAt)} に取得した内容を表示しています（閲覧のみ）。`
        : error.message,
      'error',
    );
    els.fetchStatus.replaceChildren(el('p', 'message', error.message));
    updateWriteAvailability();
  } finally {
    loading = false;
    els.reload.disabled = false;
  }
}

/* ===== オフラインの扱い ===== */

/**
 * 書き込み（取り込み・編集・登録解除・ウォッチ切替）を許してよいか。
 *
 * 「このセッションでGitHubから取れた」ことを条件にする。キャッシュのshaで
 * PUTすると、他端末の更新を巻き戻す形になりかねないため。
 */
function writesAllowed() {
  // navigator.onLine は「オフラインだと確実に分かるとき」だけ false を返す。
  // 信用しすぎない使い方（＝ボタンを止めるだけ）に留める
  return Boolean(state.collection && state.fresh && navigator.onLine !== false);
}

/** 書き込み系のボタンとオフライン告知を、いまの状態に合わせる。 */
function updateWriteAvailability() {
  const allowed = writesAllowed();
  els.importToggle.disabled = !allowed;
  els.edit.disabled = !allowed;
  els.watch.disabled = !allowed;
  els.detailTarget.disabled = !allowed;
  els.delete.disabled = !allowed;
  // 狙い選手は開いたままオフラインになることがあるので、その場で押せなくする
  if (!els.viewTargets.hidden) targetsView.refresh();

  const showBanner = Boolean(state.collection) && !allowed;
  els.offlineBanner.hidden = !showBanner;
  if (!showBanner) return;

  els.offlineBanner.textContent = state.fresh
    ? 'オフラインです。閲覧とエクスポートはできます（登録・編集はオンラインに戻ってから）。'
    : `閲覧のみ（${formatFetchedAt(state.fetchedAt)} 取得の保存分を表示中）。`
      + '登録・編集はオンラインで ↻ を押して読み直してから。';
}

/* ===== 画面の切り替え ===== */

function showView(name) {
  els.viewList.hidden = name !== 'list';
  els.viewDetail.hidden = name !== 'detail';
  els.viewForm.hidden = name !== 'form';
  els.viewTargets.hidden = name !== 'targets';
  els.viewLibrary.hidden = name !== 'library';
  els.viewChecklist.hidden = name !== 'checklist';
  els.viewGb.hidden = name !== 'gb';
  els.viewSettings.hidden = name !== 'settings';
  els.settingsToggle.setAttribute('aria-expanded', String(name === 'settings'));
  els.importToggle.setAttribute('aria-expanded', String(name === 'form'));
  els.targetsToggle.setAttribute('aria-expanded', String(name === 'targets'));
  els.libraryToggle.setAttribute('aria-expanded',
    String(name === 'library' || name === 'checklist' || name === 'gb'));

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
  els.detailBody.replaceChildren(buildDetail(row, state.sources, state.teamIndex));
  els.watch.textContent = row.card.priceWatch ? '価格ウォッチを外す' : '価格ウォッチに入れる';
  syncDetailTarget(row);
  setMessage(els.detailMessage, note ?? '', note ? 'ok' : undefined);
  showView('detail');
}

function setDetailBusy(busy) {
  if (!busy) {
    // 通信中でなくなっても、オフラインなら押せないままにする
    updateWriteAvailability();
    return;
  }
  els.edit.disabled = true;
  els.watch.disabled = true;
  els.detailTarget.disabled = true;
  els.delete.disabled = true;
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
  // 開いている所持照合・GBビューも、増えた/消えたカードに合わせて出し直す
  library.refresh();
  return result;
}

/* ===== 取り込み ===== */

/**
 * 製品のパラレル名を返す（写真判定運用仕様 §7-1 のオートコンプリート用）。
 *
 * checklists/ に無い製品、取得に失敗した場合は空配列。候補が増えないだけなので
 * 取り込みは止めない。
 */
async function checklistVariations(productKey) {
  const known = state.refs.checklists?.some((entry) => entry.key === productKey);
  if (!known) return [];
  try {
    const json = await loadRefFile('checklist', productKey, checklistPath(productKey));
    return readChecklist(json).variations.map((variation) => variation.name);
  } catch {
    return [];
  }
}

const ingestForm = createIngestForm({
  getCollection: () => state.collection,
  getTeamIndex: () => state.teamIndex,
  getChecklistVariations: checklistVariations,
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
  getTeamIndex: () => state.teamIndex,
  hasPriceOverlay: (cardId) => state.sources.cards.has(cardId),
  commit,
  onDone: (cardId, note) => openDetail(cardId, note),
});

/* ===== 狙い選手（targets.json） ===== */

/** 未作成でも書けるように、無いときは空の中身・sha なしを返す。 */
function currentTargets() {
  return state.refs.targets ?? { json: EMPTY_TARGETS, sha: '' };
}

/**
 * targets.json を更新する（保存同期方式仕様 §4）。
 * collection.json と同じ楽観ロック・409リトライを使う。
 */
async function commitTargets(apply) {
  const result = await commitTargetsFile(settings, currentTargets(), apply);
  state.refs.targets = { json: result.json, sha: result.sha };
  // GBビューの「狙い選手」も狙いの増減に合わせて出し直す
  library.refresh();
  return result;
}

const targetsView = createTargetsView({
  getTargets: currentTargets,
  // 所持照合には層に関わらず全カードを使う（ギャラリーで持っていても「所持」）
  getRows: () => state.rows,
  commit: commitTargets,
  canWrite: writesAllowed,
});

function openTargets() {
  if (!isConfigured(settings)) {
    showView('settings');
    setMessage(els.settingsMessage, '狙い選手の前に owner / repo / PAT を設定してください。', 'error');
    return;
  }
  targetsView.open();
  showView('targets');
}

/* ===== 製品（チェックリスト）とGB ===== */

/**
 * 参照データの中身を1つ取る（保存同期方式仕様 §4「選択時に個別GET」）。
 *
 * 取れたら「最後に開いた1件」として取り置き、取れなかったときは同じキーの
 * 取り置きで代用する（圏外でも直前に見た製品は開ける）。
 *
 * @param {'checklist'|'gb'} kind
 * @param {string} key productKey または breakId
 * @param {string} path リポジトリ内のパス
 */
async function loadRefFile(kind, key, path) {
  const cached = state.cache[kind];
  try {
    const { json } = await getJsonFile(settings, path);
    state.cache[kind] = { key, json };
    persistSnapshot();
    return json;
  } catch (error) {
    if (cached?.key === key) return cached.json;
    throw error;
  }
}

const library = createLibrary({
  getRefs: () => state.refs,
  getRows: () => state.rows,
  getTeamIndex: () => state.teamIndex,
  getTargets: () => state.refs.targets?.json ?? null,
  loadChecklist: (productKey) => loadRefFile('checklist', productKey, checklistPath(productKey)),
  loadGb: (breakId) => loadRefFile('gb', breakId, gbPath(breakId)),
  showView,
  onRegister: openChecklistRegister,
  onOpenCard: (cardId) => openDetail(cardId),
  canWrite: writesAllowed,
});

const checklistForm = createChecklistForm({
  getCollection: () => state.collection,
  getTeamIndex: () => state.teamIndex,
  commit,
  onDone: (note) => library.backToChecklist(note),
});

/** 所持照合の「このカードを登録」（写真判定運用仕様 §8）。 */
function openChecklistRegister(checklist, row, variation) {
  if (!requireLoaded('チェックリスト登録')) return;
  ingestForm.close();
  editForm.close();
  if (checklistForm.open(checklist, row, variation)) showView('form');
}

function openLibrary() {
  if (!isConfigured(settings)) {
    showView('settings');
    setMessage(els.settingsMessage, '製品・GBの前に owner / repo / PAT を設定してください。', 'error');
    return;
  }
  library.open();
}

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
  if (!state.fresh) {
    // キャッシュ表示中。持っているshaが今のリポジトリと一致する保証がない
    showView('list');
    setMessage(
      els.listMessage,
      `オフライン（保存分の表示）のため${action}はできません。オンラインで ↻ を押して読み直してください。`,
      'error',
    );
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

/* ===== 所持カードから狙い選手に入れる（スキーマ仕様 §9-2） ===== */

/** いま狙い選手に入っている同じ選手（nameEn の照合キーで引く）。 */
function targetEntryFor(nameEn) {
  const key = matchKey(nameEn);
  return readTargets(currentTargets().json).find((entry) => matchKey(entry.nameEn) === key) ?? null;
}

/** 詳細のボタンを、いまの狙い選手の中身に合わせる。 */
function syncDetailTarget(row) {
  const targetable = targetableFromRow(row);
  els.detailTarget.hidden = !targetable;
  if (!targetable) return;

  const already = targetEntryFor(targetable.nameEn);
  els.detailTarget.textContent = already ? '狙いから外す' : '狙いに追加';
  els.detailTarget.classList.toggle('btn--danger', Boolean(already));
}

/**
 * 詳細に出している選手を狙い選手に入れる・外す。
 *
 * ★画面と同じ `addTarget` / `removeTarget` を使う。メモは空で入れる
 * （付けたいときは★画面で足す）。外すときだけ確認を出す。
 */
async function toggleDetailTarget() {
  if (!detailCardId || !writesAllowed()) return;
  const row = state.rows.find((candidate) => candidate.card.id === detailCardId);
  const targetable = targetableFromRow(row);
  if (!targetable) return;

  const already = targetEntryFor(targetable.nameEn);
  if (already) {
    const confirmed = await askConfirm(els.detailConfirm, {
      text: `「${targetable.name}」を狙い選手から外しますか？`,
      yesLabel: '外す',
      danger: true,
    });
    if (!confirmed) return;
  }

  const now = new Date();
  setDetailBusy(true);
  setMessage(els.detailMessage, '保存中…');
  try {
    const { retried } = await commitTargets((json) => {
      const next = already
        ? removeTarget(json, targetable.nameEn, toIsoTimestamp(now))
        : addTarget(json, { ...targetable, note: '' }, toIsoDate(now), toIsoTimestamp(now));
      // 他の端末が先に入れた・外したとき（§9-2 の照合キーは nameEn）
      if (!next) {
        throw new Error(already
          ? `${targetable.nameEn} は狙い選手にありません。再読込してやり直してください。`
          : `${targetable.nameEn} はすでに狙い選手に入っています。`);
      }
      return {
        json: next,
        message: `iphone: targets ${already ? 'remove' : 'add'} ${targetable.nameEn}`,
        result: { nameEn: targetable.nameEn },
      };
    });
    const suffix = retried ? '｜競合したため取り直して保存しました' : '';
    openDetail(detailCardId, already
      ? `${targetable.name} を狙いから外しました${suffix}`
      : `${targetable.name} を狙いに追加しました${suffix}`);
  } catch (error) {
    setMessage(els.detailMessage, error.message, 'error');
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

/* ===== エクスポート ===== */

/** いま表示している内容から書き出しファイルを作る。読み込み前なら null。 */
function currentExport() {
  if (!state.collection) {
    setMessage(els.exportMessage, '先に台帳を読み込んでください（右上の ↻）。', 'error');
    return null;
  }
  return buildExport(state.collection.json, state.overlays);
}

/** 書き出したあとの案内。オーバーレイが欠けたまま書き出した場合は但し書きを付ける。 */
function exportDoneMessage(file, how) {
  const missing = [
    state.overlays.prices ? null : DATA_FILES.prices,
    state.overlays.playersInfo ? null : DATA_FILES.playersInfo,
  ].filter(Boolean);
  const base = `${file.filename} を${how}（カード${file.counts.cards}枚 / 選手${file.counts.players}人）`;
  return missing.length > 0
    ? `${base}｜${missing.join(' / ')} が無いため、価格・所属は台帳の値のままです。`
    : base;
}

async function exportShare() {
  const file = currentExport();
  if (!file) return;
  try {
    const shared = await shareFile(file.text, file.filename);
    setMessage(els.exportMessage, shared ? exportDoneMessage(file, '共有しました') : '共有をやめました。',
      shared ? 'ok' : undefined);
  } catch (error) {
    setMessage(els.exportMessage, `共有できませんでした（${error.message}）。ダウンロードを試してください。`, 'error');
  }
}

function exportDownload() {
  const file = currentExport();
  if (!file) return;
  try {
    downloadFile(file.text, file.filename);
    setMessage(els.exportMessage, exportDoneMessage(file, '書き出しました'), 'ok');
  } catch (error) {
    setMessage(els.exportMessage, `書き出せませんでした（${error.message}）。`, 'error');
  }
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

els.targetsToggle.addEventListener('click', () => {
  if (els.viewTargets.hidden) openTargets();
  else showView('list');
});

els.targetsBack.addEventListener('click', () => showView('list'));

els.libraryToggle.addEventListener('click', () => {
  if (els.viewLibrary.hidden) openLibrary();
  else showView('list');
});

els.libraryBack.addEventListener('click', () => showView('list'));
els.checklistBack.addEventListener('click', () => library.open());
els.gbBack.addEventListener('click', () => library.open());

els.reload.addEventListener('click', () => {
  ingestForm.close();
  editForm.close();
  checklistForm.close();
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
els.detailTarget.addEventListener('click', toggleDetailTarget);
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

els.exportDownload.addEventListener('click', exportDownload);
els.exportShare.addEventListener('click', exportShare);

// 圏外から戻ったら、キャッシュ表示のままにせず取り直す（＝編集できる状態に戻す）
window.addEventListener('online', () => {
  if (state.fresh) updateWriteAvailability();
  else load();
});
window.addEventListener('offline', updateWriteAvailability);

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
    text: '保存した設定（PATを含む）とオフライン用の保存データを、この端末から消去しますか？',
    note: 'GitHub側のトークンは無効になりません。不要なトークンはGitHubの設定画面で失効させてください。',
    yesLabel: '消去する',
    danger: true,
  });
  if (!confirmed) return;

  clearSettings();
  // PATを消す＝この端末を手放す場面。所持リストの写しも残さない
  clearSnapshot();
  settings = loadSettings();
  els.owner.value = settings.owner;
  els.repo.value = settings.repo;
  els.token.value = '';
  ingestForm.close();
  editForm.close();
  checklistForm.close();
  detailCardId = null;
  state.collection = null;
  state.rows = [];
  state.refs = { teams: null, targets: null, checklists: [], gb: [] };
  state.cache = { checklist: null, gb: null };
  state.filters = defaultFilters();
  applyRefs();
  filterBar.setOpen(false);
  syncTeamTheme();
  state.fetchedAt = '';
  state.fresh = false;
  els.cardList.replaceChildren();
  els.fetchStatus.replaceChildren(el('p', 'message', 'まだ読み込んでいません。'));
  setMessage(els.exportMessage, '');
  updateWriteAvailability();
  setMessage(els.settingsMessage, '消去しました。', 'ok');
});

/* ===== 起動 ===== */

fillSortOptions();
updateSortDirLabel();
// 参照データを取る前でも、空の索引と「gb/ は未登録」の注記で画面が成立するようにする
applyRefs();
filterBar.render();
showView('list');
els.exportShare.hidden = !canShareFile();
updateWriteAvailability();

// 通信を待たずに、前回読めた内容をまず出す（圏外でも一覧が開く）
if (showSnapshot()) {
  setMessage(els.listMessage, `${els.listMessage.textContent}｜${formatFetchedAt(state.fetchedAt)} 取得の保存分`);
}
load();

// file:// ではSWを登録できないため、http(s)配信時のみ
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('Service Workerの登録に失敗しました', error);
    });
  });
}
