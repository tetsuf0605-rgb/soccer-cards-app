/**
 * 参照データ（スキーマ仕様 §9）の読み取りと索引。
 *
 * collection.json にはマージしない（保存同期方式仕様 §3）。ここが持つのは
 * teams.json の索引と、狙い選手 targets.json の純粋な加工だけ。DOMもネットワークも
 * 触らない。チームの照合はすべて teams.json の正式名（name）へ正規化してから行う
 * （スキーマ仕様 §1「チーム名の照合はすべて…正規化してから行う」）。
 */
import { matchKey } from './text.js';

/** 空のチームマスタ（teams.json が未作成のとき）。 */
const EMPTY_INDEX = Object.freeze({
  teams: [],
  byId: new Map(),
  byKey: new Map(),
  isEmpty: true,
});

/**
 * teams.json から索引を作る。
 *
 * byKey には正式名・nameJa・aliases をすべて入れる。先に入ったものを優先し、
 * 別名の衝突で正式名が上書きされないようにする。
 *
 * @param {object|null} teamsJson teams.json の中身
 * @returns {{teams: Array<object>, byId: Map<string, object>, byKey: Map<string, object>, isEmpty: boolean}}
 */
export function buildTeamIndex(teamsJson) {
  const teams = Array.isArray(teamsJson?.teams) ? teamsJson.teams : [];
  if (teams.length === 0) return EMPTY_INDEX;

  const byId = new Map();
  const byKey = new Map();

  // 正式名を先に全件入れてから別名を入れる。別名が他チームの正式名と
  // ぶつかっても正式名側が勝つ（「Villa」は Aston Villa だが、仮に
  // 「Villa」という正式名のチームがあればそちらを指す）
  for (const team of teams) {
    if (!team?.id || !team.name) continue;
    byId.set(team.id, team);
    const key = matchKey(team.name);
    if (key && !byKey.has(key)) byKey.set(key, team);
  }
  for (const team of teams) {
    if (!team?.id || !team.name) continue;
    for (const alias of [team.nameJa, ...(team.aliases ?? [])]) {
      const key = matchKey(alias);
      if (key && !byKey.has(key)) byKey.set(key, team);
    }
  }

  return { teams, byId, byKey, isEmpty: false };
}

/**
 * チーム名（カード印字・現所属・在籍履歴のいずれか）を teams.json の1件に解決する。
 * 見つからなければ null（＝その文字列のまま扱う。チップには出ない）。
 */
export function resolveTeam(index, name) {
  const key = matchKey(name);
  if (!key) return null;
  return index?.byKey.get(key) ?? null;
}

/** 表示名。日本語名があればそれ、無ければ正式名。 */
export function teamLabel(team) {
  return team?.nameJa || team?.name || '';
}

/* ===== 絞り込み用のチーム照合（スキーマ仕様 §1「チーム」） ===== */

/** 照合モード。プリント時 / 現所属 / 在籍経験。 */
export const TEAM_MODES = Object.freeze([
  { id: 'print', label: 'プリント時', hint: 'カードに印字されたチーム' },
  { id: 'current', label: '現所属', hint: '選手の現在の所属チーム' },
  { id: 'career', label: '在籍経験', hint: '在籍履歴にそのチームがある選手' },
]);

export const DEFAULT_TEAM_MODE = 'print';

/** 照合モードごとに、その行が属するチーム名の生の文字列を取り出す。 */
function rawTeamNames(row, mode) {
  if (mode === 'current') {
    return row.player?.currentTeam ? [row.player.currentTeam] : [];
  }
  if (mode === 'career') {
    // careerHistory は collection.json に無い（players_info.json のオーバーレイ）。
    // merge.js が行に添えた row.career を見る
    if (!Array.isArray(row.career)) return [];
    return row.career.map((entry) => entry?.team).filter(Boolean);
  }
  return row.card.teamOnCard ? [row.card.teamOnCard] : [];
}

/**
 * 1行が属するチームのIDの集合（teams.json に無い表記は入らない）。
 * @returns {Set<string>}
 */
export function teamIdsForRow(index, row, mode) {
  const ids = new Set();
  for (const name of rawTeamNames(row, mode)) {
    const team = resolveTeam(index, name);
    if (team) ids.add(team.id);
  }
  return ids;
}

/**
 * 表示中の行に実際に出てくるチームを、所持枚数の多い順に並べる（チップと検索シート用）。
 *
 * teams.json の全159チームを並べても探せないので、母集団は「いま持っている
 * カードに出てくるチーム」に絞る。
 *
 * @param {object} index buildTeamIndex の戻り値
 * @param {Array} rows
 * @param {string} mode 照合モード
 * @returns {Array<{team: object, count: number}>}
 */
export function teamFacets(index, rows, mode) {
  const counts = new Map();
  for (const row of rows) {
    for (const id of teamIdsForRow(index, row, mode)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  const collator = new Intl.Collator('ja');
  return [...counts.entries()]
    .map(([id, count]) => ({ team: index.byId.get(id), count }))
    .filter((facet) => facet.team)
    .sort((a, b) => b.count - a.count || collator.compare(teamLabel(a.team), teamLabel(b.team)));
}

/** チーム検索シートの絞り込み（正式名・日本語名・別名のどれでも当たる）。 */
export function searchTeamFacets(facets, queryText) {
  const needle = matchKey(queryText);
  if (!needle) return facets;
  return facets.filter(({ team }) => (
    [team.name, team.nameJa, ...(team.aliases ?? [])]
      .some((name) => matchKey(name).includes(needle))
  ));
}

/**
 * 在籍履歴1件の表示文（スキーマ仕様 §9-5。粒度は年）。
 * @param {{team: string, from: string|null, to: string|null, loan?: boolean}} entry
 */
export function formatCareerEntry(entry, index) {
  const team = resolveTeam(index, entry?.team);
  const name = team ? teamLabel(team) : (entry?.team ?? '');
  const span = `${entry?.from ?? '?'}–${entry?.to ?? '現在'}`;
  return `${span}　${name}${entry?.loan ? '（ローン）' : ''}`;
}

/* ===== 狙い選手 targets.json（スキーマ仕様 §9-2） ===== */

/** targets.json から配列を取り出す（壊れていても空配列で返す）。 */
export function readTargets(targetsJson) {
  const targets = Array.isArray(targetsJson?.targets) ? targetsJson.targets : [];
  return targets.filter((entry) => entry && typeof entry === 'object' && entry.nameEn);
}

/**
 * 狙い選手を1件足した新しい targets.json を返す。
 * nameEn が照合キーなので、既にあるときは何もしない（null を返す）。
 *
 * @param {object|null} targetsJson
 * @param {{nameEn: string, name: string, playerId: string|null, note: string}} entry
 * @param {string} addedAt YYYY-MM-DD
 * @param {string} updatedAt ISO時刻
 * @returns {object|null} 変更後の中身（重複なら null）
 */
export function addTarget(targetsJson, entry, addedAt, updatedAt) {
  const targets = readTargets(targetsJson);
  const key = matchKey(entry.nameEn);
  if (targets.some((target) => matchKey(target.nameEn) === key)) return null;

  const next = {
    nameEn: entry.nameEn.trim(),
    name: entry.name.trim(),
    playerId: entry.playerId ?? null,
    note: (entry.note ?? '').trim(),
    addedAt,
  };
  const collator = new Intl.Collator('en', { sensitivity: 'base' });
  return {
    ...(targetsJson ?? {}),
    schemaVersion: targetsJson?.schemaVersion ?? 1,
    updatedAt,
    targets: [...targets, next].sort((a, b) => collator.compare(a.nameEn, b.nameEn)),
  };
}

/**
 * 所持カードの行から、狙い選手として登録する中身を作る。
 *
 * 照合キーは `nameEn`（スキーマ仕様 §9-2）なので、選手データが無い行や
 * nameEn が空の行は登録できない。そのときは null を返す（画面はボタンを隠す）。
 * カナが無ければ nameEn をそのまま名前に使う（空の name で登録しない）。
 *
 * @param {{player?: object|null}|null} row buildRows の1行
 * @returns {{nameEn: string, name: string, playerId: string|null}|null}
 */
export function targetableFromRow(row) {
  const nameEn = (row?.player?.nameEn ?? '').trim();
  if (!nameEn) return null;
  const player = row.player;
  return {
    nameEn,
    name: (player.name ?? '').trim() || nameEn,
    playerId: player.id ?? null,
  };
}

/**
 * 狙い選手を1件外した新しい targets.json を返す（無ければ null）。
 * @returns {object|null}
 */
export function removeTarget(targetsJson, nameEn, updatedAt) {
  const targets = readTargets(targetsJson);
  const key = matchKey(nameEn);
  const next = targets.filter((target) => matchKey(target.nameEn) !== key);
  if (next.length === targets.length) return null;

  return {
    ...(targetsJson ?? {}),
    schemaVersion: targetsJson?.schemaVersion ?? 1,
    updatedAt,
    targets: next,
  };
}

/**
 * 狙い選手に所持状況を添える（一覧表示用）。
 *
 * playerId が入っていればそれで、無ければ nameEn で台帳を引く（スキーマ仕様 §9-2
 * 「nameEn が照合キー」）。
 *
 * @param {Array<object>} targets
 * @param {Array} rows buildRows の結果
 * @returns {Array<{target: object, player: object|null, cards: number}>}
 */
export function describeTargets(targets, rows) {
  const byId = new Map();
  const byKey = new Map();
  for (const row of rows) {
    if (!row.player) continue;
    const id = row.player.id;
    if (!byId.has(id)) byId.set(id, { player: row.player, cards: 0 });
    byId.get(id).cards += 1;

    const key = matchKey(row.player.nameEn);
    if (key && !byKey.has(key)) byKey.set(key, id);
  }

  return targets.map((target) => {
    const id = target.playerId ?? byKey.get(matchKey(target.nameEn)) ?? null;
    const hit = id ? byId.get(id) : null;
    return { target, player: hit?.player ?? null, cards: hit?.cards ?? 0 };
  });
}
