/**
 * GitHub Contents API クライアント。
 *
 * フェーズ0の時点では読み取りのみ。collection.json への書き込み（PUT・409リトライ）は
 * フェーズ2で追加する。
 *
 * prices.json / players_info.json は cowork 所有ファイルのため、
 * このモジュールから書き込む関数は作らない（保存同期方式仕様 §2・§3）。
 */
import { decodeBase64Utf8 } from './base64.js';

const API_ROOT = 'https://api.github.com';

/** 読み取る3ファイル。値はリポジトリ直下のパス。 */
export const DATA_FILES = Object.freeze({
  collection: 'collection.json',
  prices: 'prices.json',
  playersInfo: 'players_info.json',
});

/** PWAが書き込んでよい唯一のファイル。フェーズ2のPUTでガードに使う。 */
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
