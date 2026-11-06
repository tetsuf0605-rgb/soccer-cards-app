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
import { applicableVariations } from './checklist.js';

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

/* ===== 狙い選手がどのスポットから出るか ===== */

/** cards[].kind の表示名（出るカードの種類）。 */
const KIND_LABEL = {
  auto: 'オート', relic: 'レリック', insert: 'インサート', base: 'ベース', other: 'その他',
};

/** 価値の高いものから見たい順。GBの判断材料なのでオート・レリックを先に出す。 */
const KIND_ORDER = ['auto', 'relic', 'insert', 'base', 'other'];

export function cardKindLabel(kind) {
  return KIND_LABEL[kind] ?? kind ?? '';
}

/**
 * チェックリストの1行について、シリアル入りのパラレルを数える。
 *
 * 分母は「いちばん少ない値」だけ出しても意味がない（たいてい 1/1 が入っていて
 * どの選手も同じになる）。いちばん多い値といちばん少ない値の幅で出す。
 *
 * @returns {{serial: number, total: number, min: number|null, max: number|null}}
 */
function countSerialParallels(checklist, row) {
  const byName = new Map((checklist.variations ?? []).map((v) => [v.name, v]));
  const names = applicableVariations(checklist, row);

  let serial = 0;
  let min = null;
  let max = null;
  for (const name of names) {
    const denominator = byName.get(name)?.denominator;
    if (typeof denominator !== 'number') continue;
    serial += 1;
    if (min === null || denominator < min) min = denominator;
    if (max === null || denominator > max) max = denominator;
  }
  return { serial, total: names.length, min, max };
}

/**
 * 狙い選手1人について、その製品でどんなカードが出るかをまとめる。
 * 種類（オート / レリック / インサート / ベース）ごとに畳む。
 */
function summariseCards(checklist, cards) {
  const byKind = new Map();
  for (const row of cards) {
    const kind = row.kind || 'other';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(row);
  }

  return [...byKind.entries()]
    .map(([kind, rows]) => {
      let serial = 0;
      let min = null;
      let max = null;
      for (const row of rows) {
        const counted = countSerialParallels(checklist, row);
        serial += counted.serial;
        if (counted.min !== null && (min === null || counted.min < min)) min = counted.min;
        if (counted.max !== null && (max === null || counted.max > max)) max = counted.max;
      }
      return { kind, cardNos: rows.map((row) => row.cardNo), count: rows.length, serial, min, max };
    })
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/**
 * 狙い選手（targets.json）が、このGBのどのスポットから出るかを出す。
 *
 * スポットの決め方は2段階:
 *   1. `spots[].playersEn` に名前がある → そのスポット（名指し。いちばん確か）
 *   2. 無ければ、その選手のカードに印字されたチーム（チェックリストの `cards[].team`）で引く。
 *      現所属ではなく**カードのチーム**を見る — 同じ選手でも製品によって所属が違うため
 *
 * 1チームが複数スポットに分かれているブレイクでは、名指しが無いと
 * どのスポットに入るか決められない。その場合は候補を全部返し `ambiguous` を立てる。
 *
 * @param {object} gb readGb の結果
 * @param {object|null} checklist readChecklist の結果（無ければ出るカードは分からない）
 * @param {Array<object>} targets readTargets の結果
 * @param {object} index buildTeamIndex の結果
 * @param {Array} [rows] buildRows の結果。チェックリストにカードが無い選手を
 *   現所属で拾うための保険（チェックリスト未作成のGBでも名前が消えないように）
 * @returns {Array<{target: object, spots: Array<object>, named: boolean,
 *                  ambiguous: boolean, kinds: Array<object>}>}
 */
export function targetsInBreak(gb, checklist, targets, index, rows) {
  if (!gb || !Array.isArray(targets) || targets.length === 0) return [];

  const spotsByTeam = new Map();
  for (const spot of gb.spots) {
    for (const id of spot.teamIds) {
      if (!spotsByTeam.has(id)) spotsByTeam.set(id, []);
      spotsByTeam.get(id).push(spot);
    }
  }

  const results = [];
  for (const target of targets) {
    const key = matchKey(target.nameEn);
    if (!key) continue;

    const cards = (checklist?.cards ?? []).filter((row) => matchKey(row.nameEn) === key);

    const named = gb.spots.filter((spot) => spot.playersEn.some((p) => matchKey(p) === key));

    // カードに印字されたチームからスポットを引く（名指しが無いとき用）
    const teamIds = new Set();
    for (const row of cards) {
      const team = resolveTeam(index, row.team);
      if (team) teamIds.add(team.id);
    }
    // チェックリストにこの選手のカードが無いときだけ、台帳の現所属で代用する。
    // カードのチームのほうが確かなので、あくまで保険
    if (teamIds.size === 0) {
      const player = (rows ?? [])
        .map((row) => row.player)
        .find((p) => p && (p.id === target.playerId || matchKey(p.nameEn) === key));
      const team = resolveTeam(index, player?.currentTeam);
      if (team) teamIds.add(team.id);
    }
    const byTeam = [...teamIds].flatMap((id) => spotsByTeam.get(id) ?? []);

    // 名指しを優先し、同じチームの他スポットは後ろに付ける
    const spots = [...named];
    for (const spot of byTeam) {
      if (!spots.includes(spot)) spots.push(spot);
    }
    if (spots.length === 0) continue;

    results.push({
      target,
      spots,
      named: named.length > 0,
      // 名指しが無く、同じチームに複数スポットがある＝どれに入るか決められない
      ambiguous: named.length === 0 && spots.length > 1,
      kinds: checklist ? summariseCards(checklist, cards) : [],
    });
  }
  return results;
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
