/**
 * チェックリスト登録（登録経路B。写真判定運用仕様 §8）。
 *
 * 所持照合ビューで「このカードを登録」を押すと、製品・カード番号・パラレル・
 * チーム・特徴・選手候補が埋まった状態でフォームが開く。ユーザーが入れるのは
 * serial（＋実物と一致チェック）/ storage / priceWatch / notes / gbRef だけ。
 *
 * 保存は写真判定経由と同じロジック（PUT・409リトライ・`iphone: add ...`）で、
 * 違いは sourceChecklist を記録することだけ（スキーマ仕様 §10-3）。
 */
import * as cardform from './cardform.js';
import { NEW_PLAYER } from './cardform.js';
import { valuesFromChecklistRow } from './checklist.js';
import {
  IngestError,
  addToCollection,
  buildCardRecord,
  buildPlayerRecord,
  makeCardId,
  matchPlayers,
  nextPlayerId,
  replacePlayer,
  retypePlayer,
} from './ingest.js';

/**
 * @param {{
 *   getCollection: () => {json: object, sha: string} | null,
 *   getTeamIndex: () => object | null,
 *   commit: (apply: (json: object) => object) => Promise<object>,
 *   onDone: (note: string|null) => void,
 * }} deps
 */
export function createChecklistForm(deps) {
  const state = { checklist: null, row: null, variation: '', busy: false };

  function collection() {
    return deps.getCollection()?.json ?? null;
  }

  /**
   * 1行＋パラレルを選んで開く。
   *
   * @param {object} checklist readChecklist の結果
   * @param {object} row checklist.cards[] の1件
   * @param {string} variation 選んだパラレル名
   * @returns {boolean} 開けたら true
   */
  function open(checklist, row, variation) {
    const json = collection();
    if (!json) return false;

    state.checklist = checklist;
    state.row = row;
    state.variation = variation;

    const { values } = valuesFromChecklistRow(checklist, row, variation);
    const players = json.players ?? [];

    // nameEn で既存選手を探す。完全一致が1人だけならそれを既定にする（§8-3）
    const candidates = matchPlayers(players, { nameEn: row.nameEn, name: null });
    const exact = candidates.filter((candidate) => candidate.score === 3);
    const choice = exact.length === 1 ? exact[0].player.id : NEW_PLAYER;

    cardform.setMode('checklist');
    cardform.refreshDatalists(json, deps.getTeamIndex());
    cardform.attach({ onSave: save, onCancel: leave, onBack: leave });
    cardform.fill({
      mode: 'checklist',
      progress: `チェックリストから登録: ${row.cardNo}／${variation}`,
      values,
      players,
      candidates: candidates.map((candidate) => candidate.player),
      choice,
      // 新規選手ならカナ名はユーザーが入れる（判定チャットの転写が無いため。§8-3）
      draft: {
        name: '',
        nameEn: row.nameEn,
        nationality: '',
        currentTeam: row.team ?? '',
        status: 'active',
      },
      playerRead: `チェックリストの読み取り: ${row.nameEn}${row.team ? `／${row.team}` : ''}`,
      // 製品側から来た項目は確定しているので強調しない。確かめるのはシリアルだけ
      needsCheck: ['serial'],
      priceNote: null,
    });
    return true;
  }

  function close() {
    state.checklist = null;
    state.row = null;
    state.variation = '';
    cardform.hide();
  }

  function leave() {
    if (state.busy) return;
    close();
    deps.onDone(null);
  }

  async function save() {
    if (state.busy) return;
    const read = cardform.read();
    if (!read.value) return;
    const input = read.value;

    const { checklist, row, variation } = state;
    const now = new Date();
    state.busy = true;
    cardform.setBusy(true);
    cardform.message('保存中…');

    // 採番は apply の中で行う（409で取り直したら引き直される）
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
      const card = buildCardRecord(cardId, playerId, {
        ...input.card,
        // 出自の記録（スキーマ仕様 §10-3）。写真判定経由では null のままになる
        sourceChecklist: { productKey: checklist.productKey, cardNo: row.cardNo },
      }, now);

      let next = addToCollection(json, { card, player: newPlayer }, now);
      if (retyped) next = replacePlayer(next, retyped, now);

      return { json: next, message: `iphone: add ${cardId}`, result: { card } };
    };

    try {
      const { result, retried } = await deps.commit(apply);
      close();
      deps.onDone(
        `登録しました（${result.card.id}／${row.cardNo}・${variation}）`
        + `${retried ? '｜競合したため取り直して保存しました' : ''}`,
      );
    } catch (error) {
      cardform.message(error.message, 'error');
    } finally {
      state.busy = false;
      cardform.setBusy(false);
    }
  }

  return { open, close };
}
