/**
 * チームテーマ（スキーマ仕様 §1・§9-1）。
 *
 * チームを1つだけ選んでいる間、画面をそのチームの壁紙 or 配色に切り替える。
 * 複数選択時・未選択時は既定テーマに戻す。
 *
 * 壁紙はPWAリポジトリ内の相対パス（teams.json の `wallpaper`）。当面3チーム
 * ぶんしか無く、置かれていないこともあるので、読み込みに失敗したら黙って
 * 配色グラデーションに落とす — 404で真っ白になるより、色だけでも変わるほうがよい。
 *
 * 文字の読みやすさは動かさない。カードや入力欄は不透明なままで、テーマが出るのは
 * 背景とヘッダーだけ。ヘッダーの文字色はチームカラーの明るさから決める。
 */

const root = document.documentElement;

/** 既定のヘッダー色（index.html の theme-color と合わせる）。 */
const DEFAULT_THEME_COLOR = '#0F1720';

/** 壁紙の読み込み結果。同じチームを選び直すたびに取り直さないよう覚えておく。 */
const wallpaperStatus = new Map();

/** いま当てているチームID（同じものを二重に当てない）。 */
let appliedId = null;

/** #RGB / #RRGGBB を [r, g, b] にする。読めなければ null。 */
function parseHex(value) {
  const text = String(value ?? '').trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) return short.slice(1).map((ch) => parseInt(ch + ch, 16));
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  return long ? long.slice(1).map((pair) => parseInt(pair, 16)) : null;
}

/** 相対輝度（WCAG）。チームカラーの上に白を置くか黒を置くかの判定に使う。 */
function luminance([r, g, b]) {
  const channel = (value) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function rgba([r, g, b], alpha) {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * teams.json の相対パスを、このページ基準の絶対URLにする。
 *
 * CSSカスタムプロパティに入れた url() は「スタイルシートの場所」基準で
 * 解決される。teams.json の `themes/...` はアプリのルート基準なので、
 * そのまま渡すと css/themes/... を取りにいって外す。
 *
 * @param {string} path
 * @returns {string}
 */
function toAbsolute(path) {
  return new URL(path, document.baseURI).href;
}

/**
 * 壁紙が実在するか確かめる。
 *
 * CSSの background-image で直接指定すると、404のときに「何も出ない」のか
 * 「読み込み中」なのか区別できない。Imageで先に試してから当てる。
 *
 * @param {string} path 絶対URL
 * @returns {Promise<boolean>}
 */
function loadWallpaper(path) {
  if (wallpaperStatus.has(path)) return Promise.resolve(wallpaperStatus.get(path));

  const promise = new Promise((resolve) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(true), { once: true });
    image.addEventListener('error', () => resolve(false), { once: true });
    image.src = path;
  }).then((ok) => {
    wallpaperStatus.set(path, ok);
    return ok;
  });

  // 同じ壁紙を連続で当てるときに二重で読まないよう、解決前からMapに入れておく
  wallpaperStatus.set(path, promise);
  return promise;
}

function setThemeColor(color) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', color);
}

/** 既定テーマに戻す。 */
function clearTheme() {
  appliedId = null;
  root.classList.remove('has-team-theme', 'has-team-wallpaper');
  for (const name of ['--team-primary', '--team-secondary', '--team-on-primary', '--team-wallpaper']) {
    root.style.removeProperty(name);
  }
  setThemeColor(DEFAULT_THEME_COLOR);
}

/**
 * チームテーマを当てる（null で既定に戻す）。
 *
 * @param {object|null} team teams.json の1件
 * @returns {Promise<void>} 壁紙の判定まで終わったら解決する（テストと待ち合わせ用）
 */
export async function applyTeamTheme(team) {
  if (!team?.id) {
    clearTheme();
    return;
  }
  if (team.id === appliedId) return;

  const primary = parseHex(team.colors?.primary) ?? [34, 160, 90];
  const secondary = parseHex(team.colors?.secondary) ?? primary;

  appliedId = team.id;
  root.classList.add('has-team-theme');
  root.classList.remove('has-team-wallpaper');
  root.style.setProperty('--team-primary', rgba(primary, 1));
  root.style.setProperty('--team-secondary', rgba(secondary, 1));
  // 明るいチームカラーには黒、暗いチームカラーには白を載せる
  root.style.setProperty('--team-on-primary', luminance(primary) > 0.45 ? '#14202B' : '#FFFFFF');
  root.style.removeProperty('--team-wallpaper');
  setThemeColor(rgba(primary, 1));

  if (!team.wallpaper) return;

  const url = toAbsolute(team.wallpaper);
  const ok = await loadWallpaper(url);
  // 待っている間に別のチームへ切り替わっていたら、もう当てない
  if (!ok || appliedId !== team.id) return;
  root.style.setProperty('--team-wallpaper', `url("${url}")`);
  root.classList.add('has-team-wallpaper');
}
