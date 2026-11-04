/**
 * オーバーレイマージ（保存同期方式仕様 §3）。
 *
 * collection.json（台帳本体）に、cowork所有の2ファイルを重ねる。
 * エントリがあればオーバーレイ側を優先する。
 *   cards[].price / priceHistory / estimate ← prices.json
 *   players[].currentTeam / status / birthDate / infoUpdatedAt / careerHistory ← players_info.json
 *
 * price は実測があるときだけ差し替える。prices.json の大半は推定（estimate）だけを
 * 持つエントリで、それで price を上書きすると台帳の値まで消える（スキーマ仕様 §9-7）。
 *
 * birthDate は年齢表示・年齢ソートの元（スキーマ仕様 §1「年齢はデータに持たない」）。
 * careerHistory は在籍経験での絞り込みと選手欄の表示に使う（同 §9-5）。どちらも
 * collection.json 側には持たないので、オーバーレイに無い選手では欠けたままになる。
 *
 * 戻り値の merged はスキーマ仕様の完全形に `cards[].estimate` だけを足した形。
 * estimate は表示とソートで毎行使うので行に載せ、エクスポートの直前で落とす
 * （export.js）。careerHistory は使う場所が限られるので merged には入れず、
 * career（選手ID→履歴）で別に返す。
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
    let touched = false;

    // 実測（current / checkedAt / source / history）があるときだけ price を差し替える。
    // 推定だけのエントリで差し替えると price が {current: null, ...} になり、
    // 台帳に手入力した価格まで消してしまう（prices.json の大半は推定のみ）
    if (typeof entry.current === 'number') {
      merged.price = {
        current: entry.current,
        checkedAt: entry.checkedAt ?? null,
        source: entry.source ?? null,
      };
      touched = true;
    }
    if (Array.isArray(entry.history) && entry.history.length > 0) {
      merged.priceHistory = entry.history.map(copy);
      touched = true;
    }

    // 推定価格（スキーマ仕様 §9-7）。実測とは別フィールドで、history には積まない。
    // collection.json のカードには無い項目なので、エクスポートでは落とす（export.js）
    if (entry.estimate && typeof entry.estimate === 'object') {
      merged.estimate = copy(entry.estimate);
      touched = true;
    }

    if (touched) sources.cards.add(card.id);
    return merged;
  });

  return { merged: { ...collection, players, cards }, sources, career };
}
