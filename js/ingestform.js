/**
 * 取り込みのフロー（写真判定運用仕様 §5）。
 *
 * 判定JSONを貼り付け → 1枚ずつフォームで確認 → 1枚ずつ保存（一括保存はしない）。
 * 判定と台帳の突き合わせ（選手マッチ・表記寄せ）はここが担う。
 *
 * 入力欄そのものは cardform.js（編集と共用）、純粋な変換・採番は ingest.js、
 * PUTと409リトライは github.js が持つ。
 */
import { setMessage } from './render.js';
import { askConfirm, closeConfirm } from './confirm.js';
import * as cardform from './cardform.js';
import { NEW_PLAYER } from './cardform.js';
import {
  IngestError,
  addToCollection,
  buildCardRecord,
  buildPlayerRecord,
  makeCardId,
  matchPlayers,
  nextPlayerId,
  parseIngestJson,
  replacePlayer,
  retypePlayer,
} from './ingest.js';

const els = {
  paste: document.getElementById('import-paste'),
  json: document.getElementById('ig-json'),
  read: document.getElementById('btn-import-read'),
  clip: document.getElementById('btn-import-clip'),
  pasteMessage: document.getElementById('import-paste-message'),
  confirm: document.getElementById('form-confirm'),
};

/**
 * @param {{
 *   getCollection: () => {json: object, sha: string} | null,
 *   getTeamIndex: () => object | null,
 *   commit: (apply: (json: object) => object) => Promise<object>,
 *   onExit: (summary: {saved: number, skipped: number}) => void,
 * }} deps
 */
export function createIngestForm(deps) {
  const state = {
    items: [],
    index: 0,
    saved: 0,
    skipped: 0,
    busy: false,
  };

  function collection() {
    return deps.getCollection()?.json ?? null;
  }

  /* ===== 1枚分の表示 ===== */

  function showItem() {
    const item = state.items[state.index];
    if (!item) return;

    const players = collection()?.players ?? [];
    const candidates = matchPlayers(players, item.player);
    const exact = candidates.filter((candidate) => candidate.score === 3);

    // 完全一致が1人だけなら既定で紐づけ、それ以外は新規作成から始める
    const choice = exact.length === 1 ? exact[0].player.id : NEW_PLAYER;

    // 新規登録はすべて金庫級（スキーマ仕様 §5-1）。層は選ばせず、priceWatch は
    // 既定ON（同 §1）。収納先は、シリアル・サイン・パッチ付きの当たりカードは
    // マグネットローダーに入れることが多いので、そちらを下書きにする
    const features = item.card.features ?? [];
    const premium = Boolean(item.card.serial) || features.includes('auto') || features.includes('patch');

    const total = state.items.length;
    const checks = cardform.describeChecks(item.needsCheck);

    cardform.refreshDatalists(collection(), deps.getTeamIndex());
    cardform.fill({
      mode: 'ingest',
      progress: (total > 1 ? `${state.index + 1} / ${total} 件目` : '1枚を確認して保存します')
        + (checks ? `　要確認: ${checks}` : ''),
      values: {
        ...item.card,
        variation: item.card.variation ?? 'Base',
        tier: 'vault',
        storageType: premium ? 'magnetic' : 'toploader',
        storageName: '',
        priceWatch: true,
        gbRef: '',
        price: undefined,
      },
      players,
      candidates: candidates.map((candidate) => candidate.player),
      choice,
      draft: item.player,
      playerRead: `判定の読み取り: ${item.player.name ?? '（カナ不明）'}／${item.player.nameEn ?? '（表記不明）'}`,
      needsCheck: item.needsCheck,
      priceNote: null,
    });
    els.paste.hidden = true;
  }

  /* ===== 保存 ===== */

  function setBusy(busy) {
    state.busy = busy;
    cardform.setBusy(busy);
  }

  function advance() {
    state.index += 1;
    if (state.index < state.items.length) showItem();
    else finish();
  }

  function finish() {
    const summary = { saved: state.saved, skipped: state.skipped };
    reset();
    deps.onExit(summary);
  }

  async function save() {
    if (state.busy) return;
    const read = cardform.read();
    if (!read.value) return;
    const input = read.value;

    const now = new Date();
    setBusy(true);
    cardform.message('保存中…');

    // 採番は apply の中で行う。409で取り直したときは新しい中身に対して引き直される
    const apply = (json) => {
      const existingPlayers = json.players ?? [];

      let newPlayer = null;
      let retyped = null;
      let playerId = input.choice;

      if (input.isNew) {
        playerId = nextPlayerId(existingPlayers);
        newPlayer = buildPlayerRecord(playerId, input.player);
      } else {
        const existing = existingPlayers.find((player) => player.id === playerId);
        if (!existing) {
          throw new IngestError('紐づけ先の選手が台帳から消えています。再読込してやり直してください。');
        }
        retyped = retypePlayer(existing, input.player);
      }

      const cardId = makeCardId((json.cards ?? []).map((card) => card.id), now);
      const card = buildCardRecord(cardId, playerId, input.card, now);

      let next = addToCollection(json, { card, player: newPlayer }, now);
      if (retyped) next = replacePlayer(next, retyped, now);

      return { json: next, message: `iphone: add ${cardId}`, result: { card } };
    };

    try {
      const { result, retried } = await deps.commit(apply);
      state.saved += 1;

      const note = `保存しました（${result.card.id}）${retried ? '｜競合したため取り直して保存しました' : ''}`;
      advance();
      // 次の1枚を出したあとに置き直す（fillがメッセージ欄を消すため）
      if (cardform.isOpen()) cardform.message(note, 'ok');
    } catch (error) {
      cardform.message(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  /* ===== 状態遷移 ===== */

  function reset() {
    state.items = [];
    state.index = 0;
    state.saved = 0;
    state.skipped = 0;
    els.json.value = '';
    cardform.hide();
    closeConfirm(els.confirm);
    setMessage(els.pasteMessage, '');
  }

  async function leave() {
    if (state.busy) return;

    const rest = state.items.length - state.index;
    if (rest > 0) {
      const confirmed = await askConfirm(els.confirm, {
        text: `残り${rest}枚を取り込まずに終わりますか？`,
        note: '貼り付けたJSONは残らないので、続きをやるならもう一度貼り付けてください。',
        yesLabel: '終わる',
        danger: true,
      });
      if (!confirmed) return;
    }
    finish();
  }

  function open() {
    cardform.setMode('ingest');
    reset();
    cardform.refreshDatalists(collection(), deps.getTeamIndex());
    cardform.attach({
      onSave: save,
      onSkip: () => {
        if (state.busy) return;
        state.skipped += 1;
        advance();
      },
      onCancel: leave,
      onBack: leave,
    });
    els.json.focus({ preventScroll: true });
  }

  function readJson() {
    try {
      state.items = parseIngestJson(els.json.value);
    } catch (error) {
      setMessage(els.pasteMessage, error.message, 'error');
      return;
    }
    state.index = 0;
    state.saved = 0;
    state.skipped = 0;
    showItem();
  }

  /* ===== イベント ===== */

  els.read.addEventListener('click', readJson);

  els.clip.addEventListener('click', async () => {
    try {
      els.json.value = await navigator.clipboard.readText();
      setMessage(els.pasteMessage, '貼り付けました。内容を確認して「読み込む」を押してください。', 'ok');
    } catch {
      setMessage(els.pasteMessage, 'クリップボードを読めませんでした。入力欄に直接貼り付けてください。', 'error');
    }
  });

  return { open, close: reset };
}
