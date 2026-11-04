/**
 * 狙い選手（targets.json）の画面。
 *
 * スキーマ仕様 §9-2。書き手はiPhone（PWA）で、collection.json 以外で唯一
 * PWAが書き込むファイル（保存同期方式仕様 §4）。コミット規約は `iphone: targets`。
 *
 * `nameEn` が照合キー。既にカードを持っている選手は検索から選べば nameEn /
 * カナ / playerId が揃う。まだ1枚も持っていない選手は手入力する（playerId は null）。
 */
import { el, setMessage } from './render.js';
import { askConfirm, closeConfirm } from './confirm.js';
import { describeTargets, readTargets, addTarget, removeTarget } from './refdata.js';
import { matchKey } from './text.js';
import { searchPlayers, toIsoDate, toIsoTimestamp } from './ingest.js';

/** 検索候補に出す上限。 */
const CANDIDATE_LIMIT = 12;

const els = {
  list: document.getElementById('targets-list'),
  count: document.getElementById('targets-count'),
  search: document.getElementById('tg-search'),
  candidates: document.getElementById('tg-candidates'),
  nameEn: document.getElementById('tg-nameen'),
  name: document.getElementById('tg-name'),
  note: document.getElementById('tg-note'),
  add: document.getElementById('btn-target-add'),
  message: document.getElementById('targets-message'),
  confirm: document.getElementById('targets-confirm'),
};

/**
 * @param {{
 *   getTargets: () => {json: object, sha: string} | null,
 *   getRows: () => Array,
 *   commit: (apply: (json: object) => object) => Promise<object>,
 *   canWrite: () => boolean,
 * }} deps
 */
export function createTargetsView(deps) {
  /** 検索から選んだ既存選手（手入力に切り替えたら null に戻す）。 */
  let picked = null;
  let busy = false;

  function targetsJson() {
    return deps.getTargets()?.json ?? null;
  }

  /* ===== 一覧 ===== */

  function buildRow(entry) {
    const { target, player, cards } = entry;
    const li = el('li', 'target');

    const body = el('div', 'target__body');
    body.append(el('p', 'target__name', target.name || target.nameEn));
    body.append(el('p', 'target__name-en', target.nameEn));

    const status = cards > 0
      ? `所持 ${cards}枚${player?.currentTeam ? `・${player.currentTeam}` : ''}`
      : '未所持';
    body.append(el('p', `target__status target__status--${cards > 0 ? 'owned' : 'none'}`, status));
    if (target.note) body.append(el('p', 'target__note', target.note));
    if (target.addedAt) body.append(el('p', 'target__added', `登録 ${target.addedAt}`));
    li.append(body);

    const remove = el('button', 'btn btn--ghost target__remove', '外す');
    remove.type = 'button';
    remove.dataset.nameEn = target.nameEn;
    remove.disabled = !deps.canWrite();
    li.append(remove);

    return li;
  }

  function renderList() {
    const targets = readTargets(targetsJson());
    const described = describeTargets(targets, deps.getRows());

    els.list.replaceChildren(...described.map(buildRow));
    const owned = described.filter((entry) => entry.cards > 0).length;
    els.count.textContent = targets.length === 0
      ? 'まだ登録がありません。'
      : `${targets.length}人（所持済み ${owned}人 / 未所持 ${targets.length - owned}人）`;
  }

  /* ===== 追加フォーム ===== */

  function syncAddButton() {
    els.add.disabled = busy || !deps.canWrite()
      || !els.nameEn.value.trim() || !els.name.value.trim();
  }

  function renderCandidates() {
    const text = els.search.value.trim();
    if (!text) {
      els.candidates.replaceChildren();
      return;
    }

    const players = deps.getRows()
      .map((row) => row.player)
      .filter(Boolean);
    // 同じ選手が複数枚ぶん出てくるので潰す
    const unique = [...new Map(players.map((player) => [player.id, player])).values()];
    const hits = searchPlayers(unique, text).slice(0, CANDIDATE_LIMIT);

    if (hits.length === 0) {
      els.candidates.replaceChildren(el('p', 'hint', '登録済みの選手に一致はありません。下の欄に手入力してください。'));
      return;
    }

    els.candidates.replaceChildren(...hits.map((player) => {
      const button = el('button', 'choice choice--button');
      button.type = 'button';
      button.dataset.playerId = player.id;
      const body = el('span', 'choice__body');
      body.append(el('span', 'choice__main', player.name || player.nameEn));
      body.append(el('span', 'choice__sub', [player.nameEn, player.currentTeam].filter(Boolean).join(' ・ ')));
      button.append(body);
      return button;
    }));
  }

  function pickPlayer(playerId) {
    const player = deps.getRows().find((row) => row.player?.id === playerId)?.player;
    if (!player) return;
    picked = player;
    els.nameEn.value = player.nameEn ?? '';
    els.name.value = player.name ?? '';
    els.search.value = '';
    els.candidates.replaceChildren();
    setMessage(els.message, `${player.name || player.nameEn} を入力しました。メモを足して「狙いに追加」を押してください。`, 'ok');
    syncAddButton();
  }

  function clearForm() {
    picked = null;
    els.search.value = '';
    els.nameEn.value = '';
    els.name.value = '';
    els.note.value = '';
    els.candidates.replaceChildren();
    syncAddButton();
  }

  /* ===== 書き込み ===== */

  async function runCommit(apply, done) {
    busy = true;
    syncAddButton();
    setMessage(els.message, '保存中…');
    try {
      const { retried } = await deps.commit(apply);
      done(retried);
    } catch (error) {
      setMessage(els.message, error.message, 'error');
    } finally {
      busy = false;
      syncAddButton();
      renderList();
    }
  }

  async function add() {
    if (busy || !deps.canWrite()) return;
    const nameEn = els.nameEn.value.trim();
    const name = els.name.value.trim();
    if (!nameEn || !name) {
      setMessage(els.message, 'カード表記（nameEn）と名前（カナ）の両方を入れてください。', 'error');
      return;
    }

    // 手入力でnameEnを書き換えたら、選び直した選手との紐づけは外す
    const playerId = picked && matchKey(picked.nameEn) === matchKey(nameEn) ? picked.id : null;
    const note = els.note.value;
    const now = new Date();

    await runCommit((json) => {
      const next = addTarget(json, { nameEn, name, playerId, note }, toIsoDate(now), toIsoTimestamp(now));
      if (!next) {
        throw new Error(`${nameEn} はすでに狙い選手に入っています。`);
      }
      return { json: next, message: `iphone: targets add ${nameEn}`, result: { nameEn } };
    }, (retried) => {
      clearForm();
      setMessage(els.message, `${name} を狙いに追加しました${retried ? '｜競合したため取り直して保存しました' : ''}`, 'ok');
    });
  }

  async function remove(nameEn) {
    if (busy || !deps.canWrite()) return;

    const confirmed = await askConfirm(els.confirm, {
      text: `「${nameEn}」を狙い選手から外しますか？`,
      yesLabel: '外す',
      danger: true,
    });
    if (!confirmed) return;

    const now = new Date();
    await runCommit((json) => {
      const next = removeTarget(json, nameEn, toIsoTimestamp(now));
      if (!next) {
        throw new Error(`${nameEn} は狙い選手にありません。再読込してやり直してください。`);
      }
      return { json: next, message: `iphone: targets remove ${nameEn}`, result: { nameEn } };
    }, (retried) => {
      setMessage(els.message, `${nameEn} を外しました${retried ? '｜競合したため取り直して保存しました' : ''}`, 'ok');
    });
  }

  /* ===== 外から呼ぶ ===== */

  function open() {
    closeConfirm(els.confirm);
    clearForm();
    setMessage(els.message, deps.canWrite()
      ? ''
      : '閲覧のみ（オンラインで再読込すると追加・削除できます）。');
    renderList();
  }

  /** 表示したまま状態が変わったとき（オフラインへの移行・再読込）に描き直す。 */
  function refresh() {
    renderList();
    syncAddButton();
  }

  /* ===== イベント ===== */

  els.search.addEventListener('input', renderCandidates);

  els.candidates.addEventListener('click', (event) => {
    const button = event.target.closest('[data-player-id]');
    if (button) pickPlayer(button.dataset.playerId);
  });

  for (const node of [els.nameEn, els.name]) {
    node.addEventListener('input', syncAddButton);
  }

  els.add.addEventListener('click', add);

  els.list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-name-en]');
    if (button) remove(button.dataset.nameEn);
  });

  return { open, refresh };
}
