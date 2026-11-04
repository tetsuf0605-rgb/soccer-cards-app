/**
 * オーバーレイマージ（保存同期方式仕様 §3）。
 *
 * collection.json（台帳本体）に、cowork所有の2ファイルを重ねる。
 * エントリがあればオーバーレイ側を優先する。
 *   cards[].price / priceHistory          ← prices.json
 *   players[].currentTeam / status / birthDate / infoUpdatedAt / careerHistory ← players_info.json
 *
 * birthDate は年齢表示・年齢ソートの元（スキーマ仕様 §1「年齢はデータに持たない」）。
 * careerHistory は在籍経験での絞り込みと選手欄の表示に使う（同 §9-5）。どちらも
 * collection.json 側には持たないので、オーバーレイに無い選手では欠けたままになる。
 *
 * 戻り値の merged はスキーマ仕様の完全形をそのまま保つ（余計なフィールドを足さない）。
 * エクスポートはこれをそのまま書き出せる。careerHistory は collection.json の
 * players に持たない項目なので merged には入れず、career（選手ID→履歴）で別に返す。
 * 「どの値がオーバーレイ由来か」もUI表示用に sources で別に返す。
 */

/** 入力を書き換えないための浅いコピー。 */
function copy(object) {
  return { ...object };
}

/**
 * @param {object} collection collection.json
 * @param {object|null} prices prices.json（取得できていなければ null）
 * @param {object|null} playersInfo players_info.json（同上）
 * @returns {{merged: object, sources: {cards: Set<string>, players: Set<string>}, career: Map<string, Array<object>>}}
 */
export function mergeCollection(collection, prices, playersInfo) {
  const priceEntries = (prices && typeof prices.prices === 'object' && prices.prices) || {};
  const playerEntries = (playersInfo && typeof playersInfo.players === 'object' && playersInfo.players) || {};

  const sources = { cards: new Set(), players: new Set() };
  const career = new Map();

  const players = (collection?.players ?? []).map((player) => {
    const entry = playerEntries[player.id];
    if (!entry || typeof entry !== 'object') return copy(player);

    if (Array.isArray(entry.careerHistory) && entry.careerHistory.length > 0) {
      career.set(player.id, entry.careerHistory.map(copy));
    }

    // フィールド単位で存在を見る。部分的なオーバーレイでも台帳側を巻き込まない
    const merged = copy(player);
    let touched = false;
    for (const field of ['currentTeam', 'status', 'birthDate', 'infoUpdatedAt']) {
      if (field in entry) {
        merged[field] = entry[field];
        touched = true;
      }
    }
    if (touched) sources.players.add(player.id);
    return merged;
  });

  const cards = (collection?.cards ?? []).map((card) => {
    const entry = priceEntries[card.id];
    if (!entry || typeof entry !== 'object') return copy(card);

    const merged = copy(card);
    merged.price = {
      current: entry.current ?? null,
      checkedAt: entry.checkedAt ?? null,
      source: entry.source ?? null,
    };
    merged.priceHistory = Array.isArray(entry.history) ? entry.history.map(copy) : [];
    sources.cards.add(card.id);
    return merged;
  });

  return { merged: { ...collection, players, cards }, sources, career };
}
