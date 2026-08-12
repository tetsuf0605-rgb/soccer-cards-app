/**
 * GitHub Contents API クライアント。
 *
 * 読みは3ファイル、書きは collection.json だけ（保存同期方式仕様 §4）。
 * prices.json / players_info.json は cowork 所有ファイルのため、
 * このモジュールから書き込む関数は作らない（同 §2・§3）。
 */
import { decodeBase64Utf8, encodeBase64Utf8 } from './base64.js';
import { stringifyCollection } from './serialize.js';

const API_ROOT = 'https://api.github.com';

/** 読み取る3ファイル。値はリポジトリ直下のパス。 */
export const DATA_FILES = Object.freeze({
  collection: 'collection.json',
  prices: 'prices.json',
  playersInfo: 'players_info.json',
});

/** PWAが書き込んでよい唯一のファイル。PUTの入口でガードに使う。 */
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

/** 失敗しても致命的でない取得を、例外ではなく結果オブジェクトに畳む。 */
function asOptional(promise) {
  return promise.then(
    (value) => ({ ok: true, ...value }),
    (error) => ({ ok: false, error }),
  );
}

/**
 * 3ファイルをまとめて取得する。
 *
 * collection.json は台帳本体なので失敗＝致命的。オーバーレイ2ファイルは
 * 欠けても価格・所属が古いまま表示できればよいので、失敗を握って続行する
 * （保存同期方式仕様 §3 の「オーバーレイが壊れても台帳本体は無傷」）。
 *
 * @param {{owner: string, repo: string, token: string}} settings
 */
export async function fetchAllFiles(settings) {
  const [collection, prices, playersInfo] = await Promise.all([
    getJsonFile(settings, DATA_FILES.collection),
    asOptional(getJsonFile(settings, DATA_FILES.prices)),
    asOptional(getJsonFile(settings, DATA_FILES.playersInfo)),
  ]);

  return { collection, prices, playersInfo, fetchedAt: new Date().toISOString() };
}

/* ===== 書き込み（collection.json のみ） ===== */

/** shaが古いときにGitHubが返すステータス。どちらも「取り直してやり直す」で対処する。 */
function isConflict(status) {
  return status === 409 || status === 422;
}

function describeWriteStatus(status) {
  if (isConflict(status)) {
    return 'ほかの端末の更新と競合しました。再読込してからやり直してください。';
  }
  switch (status) {
    case 401:
      return 'PATが無効か期限切れです。設定画面でトークンを入れ直してください。';
    case 403:
      return '書き込みを拒否されました。PATの権限が Contents: Read and write か確認してください。';
    case 404:
      return `${WRITABLE_PATH} が見つかりません。owner / repo とPATの対象リポジトリ指定を確認してください。`;
    default:
      return `保存に失敗しました（HTTP ${status}）。`;
  }
}

/**
 * collection.json をPUTする。
 *
 * 日本語が入るため content は必ずUTF-8経由でbase64化する（base64.js）。
 *
 * @param {{owner: string, repo: string, token: string}} settings
 * @param {object} collection 書き込む中身
 * @param {string} sha 直前に取得したsha（楽観ロック）
 * @param {string} message コミットメッセージ（保存同期方式仕様 §2の規約）
 * @returns {Promise<{sha: string}>} 書き込み後のsha
 */
export async function putCollection(settings, collection, sha, message) {
  const { owner, repo, token } = settings;
  const url = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${WRITABLE_PATH}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: { ...buildHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content: encodeBase64Utf8(stringifyCollection(collection)),
        sha,
      }),
    });
  } catch {
    throw new GitHubError('ネットワークに接続できませんでした。保存されていません。', { path: WRITABLE_PATH });
  }

  if (!response.ok) {
    throw new GitHubError(describeWriteStatus(response.status), {
      status: response.status,
      path: WRITABLE_PATH,
    });
  }

  const body = await response.json();
  return { sha: body?.content?.sha ?? '' };
}

/**
 * 楽観ロック付きで collection.json を更新する（保存同期方式仕様 §4）。
 *
 * apply は「現在の中身 → 次の中身」を作る純粋関数。409（sha不一致）のときは
 * 再GET → applyを当て直し → 再PUT を自動で1回だけ試す。IDの採番など現在の
 * 中身に依存する処理は apply の中で行うこと（取り直した内容に対して引き直される）。
 *
 * @param {{owner: string, repo: string, token: string}} settings
 * @param {{json: object, sha: string}} current 直近に取得した内容とsha
 * @param {(json: object) => {json: object, message: string, result?: unknown}} apply
 * @returns {Promise<{json: object, sha: string, result: unknown, retried: boolean}>}
 */
export async function commitCollection(settings, current, apply) {
  const first = apply(current.json);
  try {
    const { sha } = await putCollection(settings, first.json, current.sha, first.message);
    return { json: first.json, sha, result: first.result, retried: false };
  } catch (error) {
    if (!(error instanceof GitHubError) || !isConflict(error.status)) throw error;

    // 競合したら、最新を取り直して同じ変更を当て直す（自動リトライは1回だけ）
    const fresh = await getJsonFile(settings, WRITABLE_PATH);
    const second = apply(fresh.json);
    const { sha } = await putCollection(settings, second.json, fresh.sha, second.message);
    return { json: second.json, sha, result: second.result, retried: true };
  }
}
