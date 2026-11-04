/**
 * 最終取得データのキャッシュ（保存同期方式仕様 §4「オフライン」）。
 *
 * 最後に取得できた3ファイルの中身を localStorage に置き、圏外や機内モードでも
 * 一覧・詳細・エクスポートができるようにする。書き込み（登録・編集・登録解除）は
 * オンライン時のみなので、ここに置くのは表示に必要なものだけ。
 *
 * sha も一緒に持つが、これは「どの版を見せているか」の記録であって、
 * キャッシュのshaで書き込みはしない（アプリ側で取り直してから書く）。
 */

const STORAGE_KEY = 'soccer-cards:snapshot';

/**
 * 保存形式の版。上げると古いキャッシュは黙って捨てられる。
 * v2: 参照データ（teams / targets / checklists・gb のファイル一覧）を追加。
 */
const SNAPSHOT_VERSION = 2;

/**
 * 直近の取得結果を保存する。
 *
 * owner / repo も一緒に持つ。設定を別のリポジトリに変えたとき、前のリポジトリの
 * 中身を「最終取得」として出さないため。
 *
 * 参照データも対象（保存同期方式仕様 §4「取得したものはすべて localStorage に
 * キャッシュ」）。checklists / gb はファイル一覧だけ持ち、中身は持たない。
 *
 * @param {{owner: string, repo: string}} settings
 * @param {{collection: {json: object, sha: string}, overlays: {prices: object|null, playersInfo: object|null}, refs: {teams: {json: object, sha: string}|null, targets: {json: object, sha: string}|null, checklists: Array<object>, gb: Array<object>}, fetchedAt: string}} data
 * @returns {boolean} 保存できたら true（容量オーバーなどで落ちても致命的ではない）
 */
export function saveSnapshot(settings, data) {
  const snapshot = {
    version: SNAPSHOT_VERSION,
    owner: settings.owner,
    repo: settings.repo,
    fetchedAt: data.fetchedAt,
    collection: { json: data.collection.json, sha: data.collection.sha },
    prices: data.overlays.prices ?? null,
    playersInfo: data.overlays.playersInfo ?? null,
    teams: data.refs?.teams ?? null,
    targets: data.refs?.targets ?? null,
    checklists: data.refs?.checklists ?? [],
    gb: data.refs?.gb ?? [],
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    // 容量オーバー・プライベートモードなど。オフライン閲覧が効かなくなるだけで、
    // オンラインの動作には影響しないので握りつぶす
    return false;
  }
}

/**
 * 保存済みキャッシュを返す。無い・壊れている・別リポジトリのものなら null。
 *
 * @param {{owner: string, repo: string}} settings
 * @returns {{fetchedAt: string, collection: {json: object, sha: string}, overlays: {prices: object|null, playersInfo: object|null}, refs: object}|null}
 */
export function loadSnapshot(settings) {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    stored = null;
  }
  if (!stored || typeof stored !== 'object') return null;
  if (stored.version !== SNAPSHOT_VERSION) return null;
  if (stored.owner !== settings.owner || stored.repo !== settings.repo) return null;

  const json = stored.collection?.json;
  if (!json || typeof json !== 'object') return null;

  return {
    fetchedAt: typeof stored.fetchedAt === 'string' ? stored.fetchedAt : '',
    collection: { json, sha: typeof stored.collection.sha === 'string' ? stored.collection.sha : '' },
    overlays: {
      prices: stored.prices ?? null,
      playersInfo: stored.playersInfo ?? null,
    },
    refs: {
      teams: stored.teams ?? null,
      targets: stored.targets ?? null,
      checklists: Array.isArray(stored.checklists) ? stored.checklists : [],
      gb: Array.isArray(stored.gb) ? stored.gb : [],
    },
  };
}

/** キャッシュを消す（設定の消去と一緒に呼ぶ）。 */
export function clearSnapshot() {
  localStorage.removeItem(STORAGE_KEY);
}
