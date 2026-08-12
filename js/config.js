/**
 * 接続設定（PAT / owner / repo）の保存と読み出し。
 *
 * 保存同期方式仕様 §4 のとおり localStorage に置く。個人端末のホーム画面から
 * 使う前提の割り切りで、PATは平文で入る点をUI側で明示する。
 */

const STORAGE_KEY = 'soccer-cards:settings';

/** 既定値。owner / repo は設定画面で変更できる。 */
export const DEFAULTS = Object.freeze({
  owner: 'tetsuf0605-rgb',
  repo: 'soccer-cards-data',
  token: '',
});

/**
 * 保存済み設定を返す。未保存・壊れている場合は既定値。
 * @returns {{owner: string, repo: string, token: string}}
 */
export function loadSettings() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    // 壊れていたら既定値に落とす（読めないだけで実害はない）
    stored = null;
  }
  if (!stored || typeof stored !== 'object') return { ...DEFAULTS };
  return {
    owner: typeof stored.owner === 'string' && stored.owner ? stored.owner : DEFAULTS.owner,
    repo: typeof stored.repo === 'string' && stored.repo ? stored.repo : DEFAULTS.repo,
    token: typeof stored.token === 'string' ? stored.token : '',
  };
}

/**
 * 設定を保存する。値は前後の空白を落として正規化する。
 * @param {{owner: string, repo: string, token: string}} settings
 * @returns {{owner: string, repo: string, token: string}} 正規化後の設定
 */
export function saveSettings(settings) {
  const normalized = {
    owner: settings.owner.trim(),
    repo: settings.repo.trim(),
    token: settings.token.trim(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

/** 保存済み設定を消す（PATの破棄用）。 */
export function clearSettings() {
  localStorage.removeItem(STORAGE_KEY);
}

/** 読み取りに必要な項目が揃っているか。 */
export function isConfigured(settings) {
  return Boolean(settings.token && settings.owner && settings.repo);
}
