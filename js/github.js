/**
 * GitHub Contents API クライアント。
 *
 * 読みはデータ3ファイル＋参照データ（保存同期方式仕様 §4）、書きは
 * collection.json と targets.json だけ（同 §4）。prices.json /
 * players_info.json / teams.json / checklists/ / gb/ は他者が所有する
 * ファイルのため、このモジュールから書き込む関数は作らない（同 §2・§3）。
 */
import { decodeBase64Utf8, encodeBase64Utf8 } from './base64.js';
import { stringifyCollection, stringifyTargets } from './serialize.js';

const API_ROOT = 'https://api.github.com';

/** 読み取る3ファイル。値はリポジトリ直下のパス。 */
export const DATA_FILES = Object.freeze({
  collection: 'collection.json',
  prices: 'prices.json',
  playersInfo: 'players_info.json',
});

/** 参照データのうち単一ファイルのもの（スキーマ仕様 §9-1・§9-2）。 */
export const REF_FILES = Object.freeze({
  teams: 'teams.json',
  targets: 'targets.json',
});

/** 参照データのうちディレクトリのもの（同 §9-3・§9-4）。中身は選択時に個別GETする。 */
export const REF_DIRS = Object.freeze({
  checklists: 'checklists',
  gb: 'gb',
});

/** PWAが書き込んでよいパス。PUTの入口でガードに使う（保存同期方式仕様 §4）。 */
export const WRITABLE_PATHS = Object.freeze([DATA_FILES.collection, REF_FILES.targets]);

/** checklists/{productKey}.json のパス。中身は製品を開いたときだけ取る（同 §4）。 */
export function checklistPath(productKey) {
  return `${REF_DIRS.checklists}/${productKey}.json`;
}

/** gb/{breakId}.json のパス。 */
export function gbPath(breakId) {
  return `${REF_DIRS.gb}/${breakId}.json`;
}

/** 以前からある別名（書き込みの既定先）。 */
export const WRITABLE_PATH = DATA_FILES.collection;

export class GitHubError extends Error {
  constructor(message, { status = 0, path = '' } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.path = path;
  }
}

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** HTTPステータスを、次に何を直せばよいか分かる日本語にする。 */
function describeStatus(status, path) {
  switch (status) {
    case 401:
      return 'PATが無効か期限切れです。設定画面でトークンを入れ直してください。';
    case 403:
      return 'アクセスを拒否されました。PATの権限が Contents: Read and write になっているか確認してください。';
    case 404:
      // fine-grained PATは、対象リポジトリに含めていない場合も403ではなく404を返す
      return `${path} が見つかりません。owner / repo の綴りと、PATの対象リポジトリ指定を確認してください（権限不足でも404になります）。`;
    default:
      return `${path} の取得に失敗しました（HTTP ${status}）。`;
  }
}

/**
 * 1ファイルをGETしてJSONとして解釈する。
 * @param {{owner: string, repo: string, token: string}} settings
 * @param {string} path リポジトリ直下のファイル名
 * @returns {Promise<{path: string, json: unknown, sha: string, size: number}>}
 */
export async function getJsonFile(settings, path) {
  const { owner, repo, token } = settings;
  const url = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`;

  let response;
  try {
    response = await fetch(url, { headers: buildHeaders(token), cache: 'no-store' });
  } catch {
    throw new GitHubError('ネットワークに接続できませんでした。オンラインか確認してください。', { path });
  }

  if (!response.ok) {
    throw new GitHubError(describeStatus(response.status, path), { status: response.status, path });
  }

  const body = await response.json();
  if (typeof body.content !== 'string') {
    throw new GitHubError(`${path} の中身を取得できませんでした（ファイルではない可能性があります）。`, { path });
  }

  let text;
  try {
    text = decodeBase64Utf8(body.content);
  } catch {
    throw new GitHubError(`${path} のデコードに失敗しました（UTF-8として読めません）。`, { path });
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GitHubError(`${path} がJSONとして壊れています。リポジトリの中身を確認してください。`, { path });
  }

  // shaは書き込み時の楽観ロックに使うため保持する（フェーズ2）
  return { path, json, sha: body.sha, size: body.size ?? text.length };
}

/**
 * リポジトリ内のディレクトリに並ぶ .json を一覧する（中身は取らない）。
 *
 * 参照データのディレクトリは未作成のことがある。404 は「空」として返す
 * （保存同期方式仕様 §4「未作成の場合は空として扱い、エラーにしない」）。
 *
 * @param {{owner: string, repo: string, token: string}} settings
 * @param {string} dir リポジトリ直下のディレクトリ名
 * @returns {Promise<Array<{name: string, key: string, path: string, sha: string, size: number}>>}
 */
export async function listJsonDirectory(settings, dir) {
  const { owner, repo, token } = settings;
  const url = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${dir}`;

  let response;
  try {
    response = await fetch(url, { headers: buildHeaders(token), cache: 'no-store' });
  } catch {
    throw new GitHubError('ネットワークに接続できませんでした。オンラインか確認してください。', { path: dir });
  }

  // 未作成のディレクトリ。PATの対象外でも404になるが、参照データは欠けても
  // 閲覧・登録は続けられるので、ここでは区別せず空として扱う
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new GitHubError(describeStatus(response.status, dir), { status: response.status, path: dir });
  }

  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new GitHubError(`${dir} はディレクトリではありません。`, { path: dir });
  }

  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return body
    .filter((entry) => entry?.type === 'file' && typeof entry.name === 'string' && entry.name.endsWith('.json'))
    .map((entry) => ({
      name: entry.name,
      // productKey / breakId はファイル名そのもの（スキーマ仕様 §9-3・§9-4）
      key: entry.name.replace(/\.json$/, ''),
      path: entry.path,
      sha: entry.sha,
      size: entry.size ?? 0,
    }))
    .sort((a, b) => collator.compare(a.key, b.key));
}

/** 失敗しても致命的でない取得を、例外ではなく結果オブジェクトに畳む。 */
function asOptional(promise) {
  return promise.then(
    (value) => ({ ok: true, ...value }),
    (error) => ({ ok: false, error }),
  );
}

/**
 * まだ作られていない参照データを「空」に畳む。
 *
 * 404 だけは正常扱いにし（missing: true）、それ以外の失敗は asOptional と同じく
 * ok: false で返す。PATの綴り間違いも404になるので、画面では「未作成」と出す。
 */
function asMissable(promise, empty) {
  return promise.then(
    (value) => ({ ok: true, missing: false, ...value }),
    (error) => (error instanceof GitHubError && error.status === 404
      ? { ok: true, missing: true, json: empty, sha: '', size: 0 }
      : { ok: false, error }),
  );
}

/** teams.json が無いときの空の中身。 */
const EMPTY_TEAMS = Object.freeze({ schemaVersion: 1, teams: [] });
/** targets.json が無いときの空の中身（初回のPUTはこれを土台に作る）。 */
const EMPTY_TARGETS = Object.freeze({ schemaVersion: 1, targets: [] });

/**
 * 起動時の取得をまとめて行う（保存同期方式仕様 §4「読み」）。
 *
 * collection.json は台帳本体なので失敗＝致命的。オーバーレイ2ファイルは
 * 欠けても価格・所属が古いまま表示できればよいので、失敗を握って続行する
 * （保存同期方式仕様 §3 の「オーバーレイが壊れても台帳本体は無傷」）。
 * 参照データも同様に、欠けても絞り込み・テーマが効かなくなるだけで止めない。
 *
 * checklists/ と gb/ はファイル名の一覧だけを取る。中身は選択時に個別GETする
 * （同 §4。大型製品のチェックリストを起動ごとに引かないため）。
 *
 * @param {{owner: string, repo: string, token: string}} settings
 */
export async function fetchAllFiles(settings) {
  const [collection, prices, playersInfo, teams, targets, checklists, gb] = await Promise.all([
    getJsonFile(settings, DATA_FILES.collection),
    asOptional(getJsonFile(settings, DATA_FILES.prices)),
    asOptional(getJsonFile(settings, DATA_FILES.playersInfo)),
    asMissable(getJsonFile(settings, REF_FILES.teams), EMPTY_TEAMS),
    asMissable(getJsonFile(settings, REF_FILES.targets), EMPTY_TARGETS),
    asOptional(listJsonDirectory(settings, REF_DIRS.checklists).then((entries) => ({ entries }))),
    asOptional(listJsonDirectory(settings, REF_DIRS.gb).then((entries) => ({ entries }))),
  ]);

  return {
    collection,
    prices,
    playersInfo,
    teams,
    targets,
    checklists,
    gb,
    fetchedAt: new Date().toISOString(),
  };
}

/* ===== 書き込み（collection.json のみ） ===== */

/** shaが古いときにGitHubが返すステータス。どちらも「取り直してやり直す」で対処する。 */
function isConflict(status) {
  return status === 409 || status === 422;
}

function describeWriteStatus(status, path) {
  if (isConflict(status)) {
    return 'ほかの端末の更新と競合しました。再読込してからやり直してください。';
  }
  switch (status) {
    case 401:
      return 'PATが無効か期限切れです。設定画面でトークンを入れ直してください。';
    case 403:
      return '書き込みを拒否されました。PATの権限が Contents: Read and write か確認してください。';
    case 404:
      return `${path} が見つかりません。owner / repo とPATの対象リポジトリ指定を確認してください。`;
    default:
      return `保存に失敗しました（HTTP ${status}）。`;
  }
}

/**
 * 書き込んでよいパスか（保存同期方式仕様 §4）。
 *
 * PWAが書けるのは collection.json と targets.json だけ。ほかのファイルは
 * cowork か PC（Claude Code）が所有するため、誤って混ざらないよう入口で止める。
 */
function assertWritable(path) {
  if (!WRITABLE_PATHS.includes(path)) {
    throw new GitHubError(`${path} はこのアプリから書き込めません。`, { path });
  }
}

/**
 * テキスト1本をPUTする。
 *
 * 日本語が入るため content は必ずUTF-8経由でbase64化する（base64.js）。
 *
 * @param {{owner: string, repo: string, token: string}} settings
 * @param {string} path 書き込み先（WRITABLE_PATHS のいずれか）
 * @param {string} text 書き込む本文
 * @param {string|null} sha 直前に取得したsha（楽観ロック）。新規作成なら null
 * @param {string} message コミットメッセージ（保存同期方式仕様 §2の規約）
 * @returns {Promise<{sha: string}>} 書き込み後のsha
 */
export async function putJsonText(settings, path, text, sha, message) {
  assertWritable(path);
  const { owner, repo, token } = settings;
  const url = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`;

  // 新規作成では sha を送らない（送ると「存在しないblobの更新」として422になる）。
  // targets.json の初回作成がこの経路（保存同期方式仕様 §4）
  const payload = { message, content: encodeBase64Utf8(text) };
  if (sha) payload.sha = sha;

  let response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: { ...buildHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new GitHubError('ネットワークに接続できませんでした。保存されていません。', { path });
  }

  if (!response.ok) {
    throw new GitHubError(describeWriteStatus(response.status, path), {
      status: response.status,
      path,
    });
  }

  const body = await response.json();
  return { sha: body?.content?.sha ?? '' };
}

/**
 * collection.json をPUTする。
 *
 * @param {{owner: string, repo: string, token: string}} settings
 * @param {object} collection 書き込む中身
 * @param {string} sha 直前に取得したsha（楽観ロック）
 * @param {string} message コミットメッセージ
 * @returns {Promise<{sha: string}>} 書き込み後のsha
 */
export function putCollection(settings, collection, sha, message) {
  return putJsonText(settings, WRITABLE_PATH, stringifyCollection(collection), sha, message);
}

/**
 * 楽観ロック付きで1ファイルを更新する（保存同期方式仕様 §4）。
 *
 * apply は「現在の中身 → 次の中身」を作る純粋関数。409（sha不一致）のときは
 * 再GET → applyを当て直し → 再PUT を自動で1回だけ試す。IDの採番など現在の
 * 中身に依存する処理は apply の中で行うこと（取り直した内容に対して引き直される）。
 *
 * @param {{owner: string, repo: string, token: string}} settings
 * @param {string} path 書き込み先
 * @param {{json: object, sha: string}} current 直近に取得した内容とsha（新規作成なら sha: ''）
 * @param {(json: object) => {json: object, message: string, result?: unknown}} apply
 * @param {(json: object) => string} stringify 本文の体裁
 * @returns {Promise<{json: object, sha: string, result: unknown, retried: boolean}>}
 */
async function commitFile(settings, path, current, apply, stringify) {
  const first = apply(current.json);
  try {
    const { sha } = await putJsonText(settings, path, stringify(first.json), current.sha, first.message);
    return { json: first.json, sha, result: first.result, retried: false };
  } catch (error) {
    if (!(error instanceof GitHubError) || !isConflict(error.status)) throw error;

    // 競合したら、最新を取り直して同じ変更を当て直す（自動リトライは1回だけ）
    const fresh = await getJsonFile(settings, path);
    const second = apply(fresh.json);
    const { sha } = await putJsonText(settings, path, stringify(second.json), fresh.sha, second.message);
    return { json: second.json, sha, result: second.result, retried: true };
  }
}

/** 楽観ロック付きで collection.json を更新する。 */
export function commitCollection(settings, current, apply) {
  return commitFile(settings, WRITABLE_PATH, current, apply, stringifyCollection);
}

/**
 * 楽観ロック付きで targets.json を更新する（スキーマ仕様 §9-2）。
 *
 * 未作成のときは current.sha が '' で入り、初回は sha なしでPUTされる。
 */
export function commitTargets(settings, current, apply) {
  return commitFile(settings, REF_FILES.targets, current, apply, stringifyTargets);
}
