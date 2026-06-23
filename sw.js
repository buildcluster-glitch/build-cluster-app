// Service Worker: アプリシェル(index.html + アイコン)をキャッシュ
// オフラインでも localStorage データで動く + 起動が早い
// 更新時はバージョンを上げる → ユーザー次回起動時にキャッシュ更新

const CACHE = 'build-cluster-app-v1.30.174';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', e=>{
  e.waitUntil(
    caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(names => Promise.all(
      names.filter(n => n !== CACHE).map(n => caches.delete(n))
    )).then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', e=>{
  const url = new URL(e.request.url);
  // GAS API は常にネットワーク (キャッシュしない)
  if(url.hostname === 'script.google.com'){
    return;
  }
  // 同一オリジンのみキャッシュ戦略
  if(url.origin !== location.origin) return;
  // network-first for HTML (常に最新を試す)
  // cache:'no-cache' = HTTPキャッシュ(GitHub Pagesのmax-age=600)を経由せず毎回サーバーに確認
  // (変更なければ304で軽い。これが無いと配信後最大10分間 古いHTMLが返り続ける)
  if(e.request.mode === 'navigate' || e.request.destination === 'document'){
    e.respondWith(
      fetch(e.request, {cache:'no-cache'}).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(()=> caches.match(e.request).then(r => r || caches.match('./index.html')))
    );
    return;
  }
  // cache-first for others (icon, manifest)
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res=>{
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }))
  );
});
