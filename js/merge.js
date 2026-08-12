/**
 * オーバーレイマージ（保存同期方式仕様 §3）。
 *
 * collection.json（台帳本体）に、cowork所有の2ファイルを重ねる。
 * エントリがあればオーバーレイ側を優先する。
 *   cards[].price / priceHistory          ← prices.json
 *   players[].currentTeam / status / infoUpdatedAt ← players_info.json
 *
 * 戻り値の merged はスキーマ仕様v1.2の完全形をそのまま保つ（余計なフィールドを足さない）。
 * フェーズ4のエクスポートはこれをそのまま書き出せる。
 * 「どの値がオーバーレイ由来か」はUI表示用に sources で別に返す。
 */

/** 入力を書き換えないための浅いコピー。 */
function copy(object) {
  return { ...object };
}

/**
 * @param {object} collection collection.json
 * @param {object|null} prices prices.json（取得できていなければ null）
 * @param {object|null} playersInfo players_info.json（同上）
 * @returns {{merged: object, sources: {cards: Set<string>, players: Set<string>}}}
 */
export function mergeCollection(collection, prices, playersInfo) {
  const priceEntries = (prices && typeof prices.prices === 'object' && prices.prices) || {};
  const playerEntries = (playersInfo && typeof playersInfo.players === 'object' && playersInfo.players) || {};

  const sources = { cards: new Set(), players: new Set() };

  const players = (collection?.players ?? []).map((player) => {
    const entry = playerEntries[player.id];
    if (!entry || typeof entry !== 'object') return copy(player);

    // フィールド単位で存在を見る。部分的なオーバーレイでも台帳側を巻き込まない
    const merged = copy(player);
    let touched = false;
    for (const field of ['currentTeam', 'status', 'infoUpdatedAt']) {
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

  return { merged: { ...collection, players, cards }, sources };
}
