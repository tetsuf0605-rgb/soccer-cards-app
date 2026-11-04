/**
 * GB（グループブレイク）定義の読み取り（スキーマ仕様 §9-4）。
 *
 * 期待値・確率の数値はここには来ない。FCGB（gb-eval）側のレポートが正で、
 * gb/ が持つのは参照パス（evalReport）だけ（§9-4「期待値の数値は転記しない」）。
 *
 * DOMもネットワークも触らない。画面は gbview.js が持つ。
 */
import { matchKey } from './text.js';
import { resolveTeam, teamLabel } from './refdata.js';

/** spots[].type の語彙。 */
const SPOT_TYPE_LABEL = { team: 'チーム', player: '選手', combo: '複合' };

/** status の語彙（§9-4）。 */
const STATUS_LABEL = {
  evaluated: '検討のみ',
  joined: '参加した',
  received: '結果受領',
};

export function spotTypeLabel(type) {
  return SPOT_TYPE_LABEL[type] ?? type ?? '';
}

export function gbStatusLabel(status) {
  return STATUS_LABEL[status] ?? status ?? '';
}

/** format の表示名（pyt＝Pick Your Team など。読めない値はそのまま出す）。 */
const FORMAT_LABEL = { pyt: 'PYT（チーム選択）', random: 'ランダム', player: 'プレイヤーブレイク' };

export function formatLabel(format) {
  return FORMAT_LABEL[format] ?? format ?? '';
}

/**
 * GB定義JSONを扱いやすい形に整える（壊れていても落ちない）。
 *
 * @param {object|null} json gb/{breakId}.json
 */
export function readGb(json) {
  const spots = Array.isArray(json?.spots)
    ? json.spots.filter((spot) => spot && typeof spot.spotId === 'string' && spot.spotId)
    : [];

  return {
    schemaVersion: Number(json?.schemaVersion) || 1,
    breakId: json?.breakId ?? '',
    breaker: json?.breaker ?? '',
    productKey: json?.productKey ?? '',
    format: json?.format ?? '',
    boxes: typeof json?.boxes === 'number' ? json.boxes : null,
    date: json?.date ?? '',
    status: json?.status ?? '',
    evalReport: json?.evalReport ?? '',
    spots: spots.map((spot) => ({
      spotId: spot.spotId,
      name: spot.name ?? spot.spotId,
      type: spot.type ?? 'team',
      priceYen: typeof spot.priceYen === 'number' ? spot.priceYen : null,
      teamIds: Array.isArray(spot.teamIds) ? spot.teamIds.filter(Boolean) : [],
      playersEn: Array.isArray(spot.playersEn) ? spot.playersEn.filter(Boolean) : [],
    })),
  };
}

/**
 * スポットの構成チームを表示用に解決する。
 * teams.json に無いIDはそのまま文字列で見せる（黙って消さない）。
 */
export function spotTeams(index, spot) {
  return (spot.teamIds ?? []).map((id) => {
    const team = index?.byId.get(id);
    return { id, label: team ? teamLabel(team) : id, known: Boolean(team) };
  });
}

/**
 * このGBで入手したカード（cards[].gbRef が一致する行）。
 *
 * @param {string} breakId
 * @param {Array} rows buildRows の結果
 */
export function cardsFromBreak(breakId, rows) {
  if (!breakId) return [];
  return (rows ?? []).filter((row) => row.card.gbRef === breakId);
}

/**
 * スポットごとに「そのスポットで引いたことになっているカード」を割り当てる。
 *
 * gbRef はブレイク単位でしか持たないので（スキーマ仕様 §4）、スポットへの
 * 割り当てはプリント時チーム・現所属・選手名から推測する。推測なので、
 * どのスポットにも結び付かないカードは unassigned にまとめて必ず見せる。
 *
 * @param {object} gb readGb の結果
 * @param {object} index buildTeamIndex の結果
 * @param {Array} rows buildRows の結果
 */
export function assignCardsToSpots(gb, index, rows) {
  const cards = cardsFromBreak(gb.breakId, rows);
  const assigned = new Set();

  const spots = gb.spots.map((spot) => {
    const teamIds = new Set(spot.teamIds);
    const playerKeys = new Set(spot.playersEn.map(matchKey).filter(Boolean));

    const hits = cards.filter((row) => {
      const onCard = resolveTeam(index, row.card.teamOnCard);
      if (onCard && teamIds.has(onCard.id)) return true;
      const current = resolveTeam(index, row.player?.currentTeam);
      if (current && teamIds.has(current.id)) return true;
      return playerKeys.has(matchKey(row.player?.nameEn));
    });

    for (const hit of hits) assigned.add(hit.card.id);
    return { spot, rows: hits };
  });

  return {
    spots,
    cards,
    unassigned: cards.filter((row) => !assigned.has(row.card.id)),
  };
}
