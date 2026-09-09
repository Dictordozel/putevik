/**
 * Service Worker Путевика.
 *
 * Две разные стратегии, и это осознанно:
 *
 *  • Свои файлы (HTML/CSS/JS) — network-first. Классическая ловушка прототипа:
 *    SW отдаёт старый кэш, правки «не видны», и полчаса уходит на поиск причины.
 *    При живой сети всегда берём свежий файл, кэш остаётся страховкой на офлайн.
 *
 *  • Тайлы карты — cache-first с фоновым обновлением. Плитки не меняются,
 *    а трафик и время загрузки экономят заметно. Кэш ограничен, иначе
 *    хранилище растёт бесконечно.
 */

const VERSION = 'v4';
const SHELL_CACHE = `putevik-shell-${VERSION}`;
const TILE_CACHE = 'putevik-tiles-v1';

const TILE_HOST = 'tile.openstreetmap.org';
const TILE_LIMIT = 600;

const SHELL = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './js/config.js',
    './js/store.js',
    './js/geo.js',
    './js/map.js',
    './js/ui.js',
    './js/geodesy.js',
    './vendor/leaflet.js',
    './vendor/leaflet.css',
    './manifest.webmanifest',
    './icons/icon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

/* ============================== Установка ============================== */

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        // Пофайлово, а не addAll: один недоступный файл не должен срывать установку.
        await Promise.allSettled(SHELL.map((path) => cache.add(new Request(path, { cache: 'reload' }))));
    })());
});

/* ============================== Активация ============================== */

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keep = new Set([SHELL_CACHE, TILE_CACHE]);
        const names = await caches.keys();
        await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ============================== Запросы ============================== */

self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Кэшировать имеет смысл только GET; остальное отдаём сети как есть.
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    if (url.hostname.endsWith(TILE_HOST)) {
        event.respondWith(tileStrategy(request));
        return;
    }

    if (url.origin === self.location.origin) {
        event.respondWith(appStrategy(request));
    }
});

/* ============================== Стратегии ============================== */

/** Свои файлы: сеть в приоритете, кэш — запасной вариант. */
async function appStrategy(request) {
    const cache = await caches.open(SHELL_CACHE);

    try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
    } catch {
        const cached = await cache.match(request);
        if (cached) return cached;

        // Офлайн-переход по адресу приложения: отдаём оболочку.
        if (request.mode === 'navigate') {
            const shell = await cache.match('./index.html') || await cache.match('./');
            if (shell) return shell;
        }

        return new Response('Нет сети и нет кэша для этого файла.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    }
}

/** Тайлы: кэш сразу, обновление в фоне. */
async function tileStrategy(request) {
    const cache = await caches.open(TILE_CACHE);
    const cached = await cache.match(request);

    if (cached) {
        // Обновляем молча — пользователь уже видит плитку.
        refreshTile(cache, request);
        return cached;
    }

    try {
        const response = await fetch(request);
        if (response.ok) {
            await cache.put(request, response.clone());
            trimTiles(cache);
        }
        return response;
    } catch {
        // Заглушка вместо «битой картинки»: карта просто останется пустой,
        // а векторные слои маршрута продолжат работать.
        return new Response('', { status: 504, statusText: 'Tile unavailable' });
    }
}

async function refreshTile(cache, request) {
    try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response);
    } catch {
        // Нет сети — оставляем то, что уже лежит в кэше.
    }
}

/** Ограничение размера кэша тайлов: удаляем самые старые записи. */
async function trimTiles(cache) {
    const keys = await cache.keys();
    const excess = keys.length - TILE_LIMIT;
    if (excess <= 0) return;
    await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
}
