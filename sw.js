/**
 * Service Worker — ネットワーク優先の最小構成。
 *
 * 目的はPWAとしてのインストール可能性と、圏外でもアプリ殻が開くこと。
 * キャッシュ優先にすると古い殻を掴んで更新が届かなくなるため、必ずネットワークを
 * 先に試し、失敗したときだけキャッシュに落とす。
 *
 * データ（3ファイル）はここでは扱わない。GitHub APIのレスポンスはSWを通さず、
 * 最終取得の内容は js/cache.js が localStorage に持つ。
 */

const CACHE_NAME = 'soccer-cards-shell-v3';

/**
 * インストール時に取っておくアプリ殻。
 *
 * 実行時キャッシュ（fetchハンドラ）だけだと、初回起動の直後に圏外へ入った場合に
 * 取り損ねたファイルが出る。すべて静的importなので一覧は手で並べれば足りる。
 */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/base64.js',
  './js/cache.js',
  './js/cardform.js',
  './js/config.js',
  './js/confirm.js',
  './js/editform.js',
  './js/export.js',
  './js/github.js',
  './js/ingest.js',
  './js/ingestform.js',
  './js/merge.js',
  './js/query.js',
  './js/render.js',
  './js/serialize.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 1つでも失敗すると addAll は全部落ちるので、1件ずつ入れて取れたものだけ残す
    await Promise.allSettled(SHELL.map(async (path) => {
      // cache: 'reload' でHTTPキャッシュを迂回し、必ず今の版を取る
      const response = await fetch(new Request(path, { cache: 'reload' }));
      if (response.ok) await cache.put(path, response);
    }));
  })());
  // 新しいSWを即座に有効化する（更新を溜めない）
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // 同一オリジン（アプリ殻）だけを扱う。
  // GitHub APIへのリクエストはSWを通さない — PATで認証した個人データを
  // キャッシュに残さないため。
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        // 保存はレスポンスを返したあとでよい。waitUntilで中断されないようにする
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      if (cached) return cached;

      // 画面遷移（ホーム画面からの起動を含む）だけは、URLが一致しなくても
      // 入口のHTMLを返す。オフラインで白紙になるのを防ぐ
      if (request.mode === 'navigate') {
        const shell = await caches.match('./');
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
