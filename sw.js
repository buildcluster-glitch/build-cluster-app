// Service Worker: アプリシェル(index.html + アイコン)をキャッシュ
// オフラインでも localStorage データで動く + 起動が早い
// 更新時はバージョンを上げる → ユーザー次回起動時にキャッシュ更新

// ⚠版を上げるたびにここも上げる。据え置きだと古い実体が居座り続ける(v1.30.406のまま固定されていた)
const CACHE = 'build-cluster-app-v1.30.762';
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
  // 🚦 flags.json(非常用スイッチ・v1.30.705)は常にネットワーク。キャッシュに残すと切替が効かない
  if(url.pathname.endsWith('/flags.json')) return;
  // network-first for HTML (常に最新を試す)
  // cache:'no-cache' = HTTPキャッシュ(GitHub Pagesのmax-age=600)を経由せず毎回サーバーに確認
  // (変更なければ304で軽い。これが無いと配信後最大10分間 古いHTMLが返り続ける)
  if(e.request.mode === 'navigate' || e.request.destination === 'document'){
    e.respondWith(
      fetch(e.request, {cache:'no-cache'}).then(res => {
        // 🔴v1.30.756: **成功した時だけ**キャッシュに入れる。
        //   旧実装は応答の中身を見ずに焼いていたので、公開の差し替え中に返る
        //   エラーページや中途半端な応答を掴むと、それが**真っ白の画面として残り続けた**。
        //   (2026-09-20 スマホで真っ白。10分で3回公開した直後)
        if(res && res.ok && res.type === 'basic'){
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(()=>{});
        }
        // 失敗の応答はキャッシュに残っている**前の正しい画面**で受ける(白画面を見せない)
        if(res && !res.ok){
          return caches.match('./index.html').then(r => r || res);
        }
        return res;
      }).catch(()=> caches.match(e.request).then(r => r || caches.match('./index.html')))
    );
    return;
  }
  // cache-first for others (icon, manifest)
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res=>{
      if(res && res.ok && res.type === 'basic'){          // ⚠ここも成功した時だけ
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone)).catch(()=>{});
      }
      return res;
    }))
  );
});
