// Cache simples pra permitir abrir o app offline com os últimos dados carregados.
// Estático (HTML/JS/manifest): cache-first — muda pouco, versionar via CACHE_ESTATICO.
// Dados do GitHub (api.github.com): network-first — sempre tenta buscar fresco primeiro,
// só cai pro cache se estiver offline (nunca queremos servir dado velho por padrão).
const CACHE_ESTATICO = 'prazos-estatico-v1';
const CACHE_DADOS = 'prazos-dados-v1';
const ARQUIVOS_ESTATICOS = ['./', './index.html', './app.js', './lib/prazosEngine.mjs', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_ESTATICO).then((cache) => cache.addAll(ARQUIVOS_ESTATICOS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((chaves) => Promise.all(
      chaves.filter((c) => c !== CACHE_ESTATICO && c !== CACHE_DADOS).map((c) => caches.delete(c)),
    )),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return; // nunca intercepta POST (ex.: workflow_dispatch)

  const url = new URL(event.request.url);

  if (url.hostname === 'api.github.com') {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const copia = resp.clone();
          caches.open(CACHE_DADOS).then((cache) => cache.put(event.request, copia));
          return resp;
        })
        .catch(() => caches.match(event.request)),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(caches.match(event.request).then((cache) => cache || fetch(event.request)));
  }
});
