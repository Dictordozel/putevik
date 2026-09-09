/**
 * Путевик — точка входа.
 *
 * Здесь сходятся четыре модуля: store (состояние), map (Leaflet),
 * geo (позиция) и ui (панель). Вся логика прохождения маршрута — тоже здесь,
 * потому что она единственная, кому нужны сразу и позиция, и состояние.
 */

import * as store from './js/store.js';
import { createMapView } from './js/map.js';
import { createTracker, FALLBACK_CENTER } from './js/geo.js';
import { createUI } from './js/ui.js';
import { distance } from './js/geodesy.js';

/** Минимальная точность, при которой вообще можно засчитывать точку, м. */
const accuracyLimitFor = (radius) => Math.max(30, radius);

/** Сколько подряд фиксов внутри радиуса нужно, чтобы статус не мигал на границе. */
const ARRIVAL_STREAK = 2;

const TICK_MS = 1000;

/* ============================== Проверка окружения ============================== */

const ui = createUI(buildHandlers());

if (typeof L === 'undefined') {
    ui.showBootError(
        'Не загрузилась библиотека карт',
        'Leaflet не найден в папке vendor/. Проверьте, что файлы vendor/leaflet.js и vendor/leaflet.css на месте, и перезагрузите страницу.'
    );
    throw new Error('Leaflet is not available');
}

/* ============================== Состояние сессии ============================== */

let lastFix = null;
let addMode = false;
let follow = store.getState().settings.autoFollow;
let lowAccuracy = false;
let arrivalStreak = 0;
let streakTargetId = null;
let wakeLock = null;
let updateReady = false;

/* ============================== Карта ============================== */

const mapView = createMapView({
    el: document.getElementById('map'),

    onMapClick(latlng) {
        if (!addMode) return;
        const place = store.addCheckpoint(latlng);
        setAddMode(false);
        ui.setDrawer('half');
        ui.toast(`Добавлена точка «${place.name}»`, 'ok');
    },

    onCheckpointMoved(id, latlng) {
        store.updatePlace(id, latlng);
        ui.toast('Точка перемещена');
    },

    onTilesStateChange() {
        refreshNetworkChip();
    },
});

mapView.setFollow(follow);
mapView.setUserDragHandler((latlng) => tracker.teleport(latlng));

/* ============================== Позиция ============================== */

const tracker = createTracker({
    onUpdate(fix) {
        lastFix = fix;
        mapView.setUser(fix);
        evaluateArrival(fix);
        renderAll();
        ui.setGps({ status: tracker.status, detail: null, fix, lowAccuracy });
    },

    onStatus({ status, detail, lastFix: fix }) {
        ui.setGps({ status, detail, fix: fix ?? lastFix, lowAccuracy });
        if (detail && (status === 'denied' || status === 'insecure' || status === 'unavailable')) {
            ui.toast(detail, 'warn');
        }
        ui.setSim(tracker.mode === 'sim', tracker.isWalking);
    },
});

tracker.setWalkTargetSource(() => store.nextTarget());

/* ============================== Логика прохождения ============================== */

/**
 * Засчитывает следующую точку, если пользователь внутри её радиуса.
 *
 * Две защиты от ложных срабатываний:
 *  1. фикс с большой погрешностью игнорируется — иначе Wi-Fi-позиция с ±500 м
 *     «прошла» бы весь маршрут, не сходя с места;
 *  2. нужны два подряд фикса внутри радиуса, чтобы точка не переключалась
 *     туда-обратно на границе зоны.
 */
function evaluateArrival(fix) {
    const target = store.nextTarget();

    if (!target) {
        arrivalStreak = 0;
        streakTargetId = null;
        lowAccuracy = false;
        return;
    }

    if (fix.accuracy > accuracyLimitFor(target.radius)) {
        lowAccuracy = true;
        arrivalStreak = 0;
        return;
    }
    lowAccuracy = false;

    if (target.id !== streakTargetId) {
        streakTargetId = target.id;
        arrivalStreak = 0;
    }

    if (distance(fix, target) > target.radius) {
        arrivalStreak = 0;
        return;
    }

    arrivalStreak++;
    if (arrivalStreak < ARRIVAL_STREAK) return;

    arrivalStreak = 0;
    if (!store.completeCheckpoint(target.id)) return;

    navigator.vibrate?.([40, 60, 120]);

    const stats = store.routeStats();
    if (stats.finished) {
        ui.toast(`Маршрут «${store.activeRoute().name}» пройден полностью! 🎉`, 'ok');
        tracker.stopWalk();
        releaseWakeLock();
    } else {
        ui.toast(`«${target.name}» пройдена 🎉 Осталось ${stats.count - stats.completedCount}`, 'ok');
    }
}

/* ============================== Рендер ============================== */

function renderAll() {
    const places = store.activePlaces();
    const statuses = store.statuses();
    const target = store.nextTarget();

    const distances = lastFix
        ? places.map((place) => distance(lastFix, place))
        : places.map(() => NaN);

    mapView.renderRoute(places, statuses);
    mapView.setLeg(lastFix, target);

    ui.render({
        routeName: store.activeRoute().name,
        places,
        statuses,
        stats: store.routeStats(),
        target: target ? { place: target, distance: lastFix ? distance(lastFix, target) : NaN } : null,
        distances,
        addMode,
        follow,
    });

    if (document.getElementById('routes-sheet').open) renderRoutesSheet();
}

function renderRoutesSheet() {
    const state = store.getState();
    ui.renderRoutes(state.routes, state.activeRouteId, (id) => store.routeStats(id));
}

store.subscribe(renderAll);

/* ============================== Режим добавления ============================== */

function setAddMode(on) {
    addMode = on;
    mapView.setAddMode(on);
    renderAll();
}

/* ============================== Сеть ============================== */

function refreshNetworkChip() {
    ui.setOffline(!navigator.onLine, mapView.tilesDown);
}

window.addEventListener('online', () => {
    refreshNetworkChip();
    ui.toast('Сеть вернулась', 'ok');
});

window.addEventListener('offline', () => {
    refreshNetworkChip();
    ui.toast('Сеть пропала — маршрут продолжает работать', 'warn');
});

/* ============================== Экран не должен гаснуть ============================== */

async function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
        // Батарея на исходе или браузер не разрешает — не критично.
    }
}

function releaseWakeLock() {
    wakeLock?.release?.();
    wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.activePlaces().length) requestWakeLock();
});

/* ============================== Обработчики интерфейса ============================== */

function buildHandlers() {
    return {
        onToggleAdd(force) {
            setAddMode(typeof force === 'boolean' ? force : !addMode);
            if (addMode) requestWakeLock();
        },

        onLocate() {
            follow = !follow;
            mapView.setFollow(follow);
            store.setSetting('autoFollow', follow);
            if (follow && lastFix) mapView.center(lastFix);
            if (!lastFix) {
                tracker.retry();
                ui.toast('Ищем вашу позицию…');
            }
        },

        onRenameActiveRoute(name) {
            store.renameRoute(store.getState().activeRouteId, name);
        },

        onEditPlace(id, patch) {
            store.updatePlace(id, patch);
        },

        onRemovePlace(id) {
            store.removeCheckpoint(id);
            ui.toast('Точка удалена');
        },

        onMovePlace(id, direction) {
            store.moveCheckpoint(id, direction);
        },

        onCenterPlace(id) {
            const place = store.getState().places[id];
            if (!place) return;
            follow = false;
            mapView.setFollow(false);
            mapView.center(place, 17);
            ui.setDrawer('peek');
        },

        onResetProgress() {
            if (!confirm('Сбросить прогресс прохождения этого маршрута?')) return;
            store.resetProgress();
            arrivalStreak = 0;
            streakTargetId = null;
            ui.toast('Прогресс сброшен');
        },

        onClearRoute() {
            if (!confirm('Удалить все точки этого маршрута?')) return;
            store.clearActiveRoute();
            ui.invalidateList();
            ui.toast('Маршрут очищен');
        },

        onOpenRoutes() {
            renderRoutesSheet();
            ui.openRoutesSheet();
        },

        onSelectRoute(id) {
            store.selectRoute(id);
            ui.invalidateList();
            ui.closeRoutesSheet();
            mapView.fitRoute(store.activePlaces());
            ui.toast(`Маршрут «${store.activeRoute().name}» открыт`);
        },

        onNewRoute() {
            const route = store.createRoute();
            ui.invalidateList();
            ui.closeRoutesSheet();
            setAddMode(true);
            ui.toast(`Создан «${route.name}» — тапните по карте`, 'ok');
        },

        onRenameRoute(id, current) {
            const name = prompt('Новое название маршрута:', current);
            if (name === null) return;
            store.renameRoute(id, name.trim() || current);
            renderRoutesSheet();
        },

        onDuplicateRoute(id) {
            const route = store.duplicateRoute(id);
            if (route) ui.toast(`Создана копия «${route.name}»`, 'ok');
            renderRoutesSheet();
        },

        onDeleteRoute(id, name) {
            if (!confirm(`Удалить маршрут «${name}»? Это действие не отменить.`)) return;
            store.deleteRoute(id);
            ui.invalidateList();
            renderRoutesSheet();
            ui.toast('Маршрут удалён');
        },

        onExport() {
            try {
                const blob = new Blob([store.exportJSON()], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                const stamp = new Date().toISOString().slice(0, 10);

                link.href = url;
                link.download = `putevik-${stamp}.json`;
                link.click();

                setTimeout(() => URL.revokeObjectURL(url), 1000);
                ui.toast('Файл маршрутов сохранён', 'ok');
            } catch (err) {
                ui.toast(`Не удалось выгрузить: ${err.message}`, 'error');
            }
        },

        async onImport(file) {
            try {
                const result = store.importJSON(await file.text());
                ui.invalidateList();
                renderRoutesSheet();
                mapView.fitRoute(store.activePlaces());
                ui.toast(`Импортировано маршрутов: ${result.routes}, точек: ${result.places}`, 'ok');
            } catch (err) {
                ui.toast(`Импорт не удался: ${err.message}`, 'error');
            }
        },

        onSimToggle(on) {
            const seed = lastFix
                ? { lat: lastFix.lat, lng: lastFix.lng }
                : (store.activePlaces()[0] ?? FALLBACK_CENTER);

            tracker.setMode(on ? 'sim' : 'real', { lat: seed.lat, lng: seed.lng });
            store.setSetting('simulate', on);
            ui.setSim(on, tracker.isWalking);
            ui.toast(on ? 'Режим симуляции включён' : 'Вернулись к настоящему GPS');
        },

        onToggleAutowalk() {
            const walking = tracker.toggleWalk();
            ui.setSim(tracker.mode === 'sim', walking);
            if (walking) {
                requestWakeLock();
                if (!store.nextTarget()) ui.toast('Идти некуда: маршрут пуст или пройден', 'warn');
            }
        },

        onUpdateApp() {
            if (!updateReady) return location.reload();
            updateReady.postMessage({ type: 'SKIP_WAITING' });
        },
    };
}

/* ============================== Service Worker ============================== */

function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || window.isSecureContext === false) return;

    // Запоминаем до регистрации: при первой установке контроллера ещё нет,
    // и его появление не должно вызывать перезагрузку страницы.
    const hadController = Boolean(navigator.serviceWorker.controller);

    navigator.serviceWorker.register('./sw.js', { scope: './' }).then((registration) => {
        registration.addEventListener('updatefound', () => {
            const installing = registration.installing;
            if (!installing) return;

            installing.addEventListener('statechange', () => {
                // Новая версия готова, но старая всё ещё управляет страницей —
                // предлагаем обновиться, а не подменяем код под ногами.
                if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                    updateReady = installing;
                    ui.setUpdateAvailable(true);
                }
            });
        });
    }).catch((err) => console.warn('Service Worker не зарегистрирован:', err));

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true;
        location.reload();
    });
}

/* ============================== Старт ============================== */

function boot() {
    if (store.initialWarning === 'data-corrupt') {
        ui.toast('Сохранённые данные были повреждены — начали с чистого маршрута', 'warn');
    }
    if (store.initialWarning === 'storage-unavailable') {
        ui.toast('Браузер запретил локальное хранилище: маршрут не сохранится', 'warn');
    }

    store.setStorageErrorHandler(() => {
        ui.toast('Хранилище переполнено — изменения больше не сохраняются', 'error');
    });

    const places = store.activePlaces();
    if (places.length) {
        mapView.fitRoute(places);
        ui.setDrawer('half');
    }

    renderAll();
    refreshNetworkChip();

    // Режим симуляции восстанавливаем из настроек, иначе после перезагрузки
    // отладочный сеанс каждый раз начинался бы заново.
    if (store.getState().settings.simulate) {
        const seed = places[0] ?? FALLBACK_CENTER;
        tracker.setMode('sim', { lat: seed.lat, lng: seed.lng });
        ui.setSim(true, false);
    } else {
        tracker.start();
    }

    setInterval(() => {
        if (lastFix) ui.setFixAge(Date.now() - lastFix.timestamp);
    }, TICK_MS);

    // Leaflet должен пересчитать размеры после смены раскладки drawer → сайдбар.
    window.matchMedia('(min-width: 900px)').addEventListener('change', () => mapView.invalidate());
    window.addEventListener('resize', () => mapView.invalidate());

    registerServiceWorker();
}

boot();
