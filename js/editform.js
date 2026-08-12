/**
 * 編集のフロー。
 *
 * 詳細画面から1枚を開き、カードの項目と選手の紐づけ・表記を直して保存する。
 * 入力欄は取り込みと同じ cardform.js。書き込むのは collection.json だけ。
 *
 * 直せるのはiPhone側の責務ぶんだけ（スキーマ仕様 §6）。
 *   カード: 全項目（priceHistory は cowork の担当なので持ち越す）
 *   選手  : 表記（name / nameEn / nationality / notes）と、どの選手に紐づけるか
 */
import * as cardform from './cardform.js';
import { NEW_PLAYER } from './cardform.js';
import {
  IngestError,
  addPlayerToCollection,
  applyCardEdit,
  buildPlayerRecord,
  matchPlayers,
  nextPlayerId,
  replaceCard,
  replacePlayer,
  retypePlayer,
  valuesFromCard,
} from './ingest.js';

/**
 * @param {{
 *   getCollection: () => {json: object, sha: string} | null,
 *   hasPriceOverlay: (cardId: string) => boolean,
 *   commit: (apply: (json: object) => object) => Promise<object>,
 *   onDone: (cardId: string|null) => void,
 * }} deps
 */
export function createEditForm(deps) {
  const state = { cardId: null, busy: false };

  function collection() {
    return deps.getCollection()?.json ?? null;
  }

  /** 詳細画面から1枚を開く。台帳に無ければ false。 */
  function open(cardId) {
    const json = collection();
    const card = (json?.cards ?? []).find((candidate) => candidate.id === cardId);
    if (!card) return false;

    const players = json.players ?? [];
    const current = players.find((player) => player.id === card.playerId) ?? null;

    state.cardId = cardId;
    cardform.setMode('edit');
    cardform.refreshDatalists(json);
    cardform.attach({ onSave: save, onCancel: leave, onBack: leave });
    cardform.fill({
      mode: 'edit',
      progress: `編集: ${card.id}`,
      values: valuesFromCard(card),
      players,
      // 現在の紐づけ先を先頭に。ほかの選手へ替えるときは検索欄から選ぶ
      candidates: current ? [current] : matchPlayers(players, {}).map((hit) => hit.player),
      choice: current ? current.id : NEW_PLAYER,
      draft: current ? null : { name: '', nameEn: '', nationality: '', status: 'unknown' },
      playerRead: current
        ? ''
        : 'このカードの選手レコードが見つかりません。選び直すか、新規作成してください。',
      needsCheck: [],
      priceNote: deps.hasPriceOverlay(cardId)
        ? '一覧・詳細に出ている価格は prices.json（cowork）の値です。ここで直せるのは台帳側の価格で、表示は cowork の値が優先されます。'
        : null,
    });
    return true;
  }

  function leave() {
    if (state.busy) return;
    const cardId = state.cardId;
    close();
    deps.onDone(cardId);
  }

  function close() {
    state.cardId = null;
    cardform.hide();
  }

  async function save() {
    if (state.busy) return;
    const read = cardform.read();
    if (!read.value) return;
    const input = read.value;
    const cardId = state.cardId;

    const now = new Date();
    state.busy = true;
    cardform.setBusy(true);
    cardform.message('保存中…');

    const apply = (json) => {
      const target = (json.cards ?? []).find((candidate) => candidate.id === cardId);
      if (!target) {
        throw new IngestError(`${cardId} が台帳にありません。再読込してやり直してください。`);
      }

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

      let next = replaceCard(json, applyCardEdit(target, playerId, input.card, now), now);
      if (newPlayer) next = addPlayerToCollection(next, newPlayer, now);
      if (retyped) next = replacePlayer(next, retyped, now);

      return { json: next, message: `iphone: edit ${cardId}`, result: { cardId } };
    };

    try {
      const { retried } = await deps.commit(apply);
      close();
      deps.onDone(cardId, `保存しました（${cardId}）${retried ? '｜競合したため取り直して保存しました' : ''}`);
    } catch (error) {
      cardform.message(error.message, 'error');
    } finally {
      state.busy = false;
      cardform.setBusy(false);
    }
  }

  return { open, close };
}
