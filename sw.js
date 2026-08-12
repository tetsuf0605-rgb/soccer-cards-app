/**
 * Service Worker — ネットワーク優先の最小構成。
 *
 * 目的はPWAとしてのインストール可能性の確保のみ。キャッシュ優先にすると
 * 古いアプリ殻を掴んで更新が届かなくなるため、必ずネットワークを先に試し、
 * 失敗したときだけキャッシュに落とす。
 */

const CACHE_NAME = 'soccer-cards-shell-v1';

self.addEventListener('install', () => {
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
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw error;
    }
  })());
});
