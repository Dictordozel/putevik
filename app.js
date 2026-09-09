/**
 * Путевик — точка входа.
 *
 * Здесь сходятся четыре модуля: store (состояние), map (Leaflet),
 * geo (позиция) и ui (панель). Вся логика прохождения маршрута — тоже здесь,
 * потому что она единственная, кому нужны сразу и позиция, и состояние.
 */

import * as store from './js/store.js';
import { createMapView } from './js/map.js';
import { createTracker } from './js/geo.js';
import { createUI } from './js/ui.js';
import { distance } from './js/geodesy.js';

/** Минимальная точность, при которой вообще можно засчитывать точку, м. */
const accuracyLimitFor = (radius) => Math.max(30, radius);

/** Сколько подряд фиксов внутри радиуса нужно, чтобы статус не мигал на границе. */
const ARRIVAL_STREAK = 2;

const TICK_MS = 1000;

/* ============================== Проверка окружения ============================== */

const ui = createUI(buildHandlers());

/**
 * Большой экран с мышью — не наша площадка.
 *
 * Приёмника GPS у компьютера нет: браузер определяет позицию по сети,
 * и она приходит за сотни километров от пользователя (через VPN — вообще
 * из другой страны). Строить и проверять маршрут в таких условиях нельзя,
 * поэтому здесь показываем только адрес, а карту не поднимаем вовсе —
 * заодно не запрашиваем разрешение на геолокацию впустую.
 *
 * Проверяем и ширину, и тип указателя: телефон в альбомной ориентации
 * бывает шире 900px, но указатель у него всегда грубый.
 */
if (window.matchMedia('(min-width: 900px) and (pointer: fine)').matches) {
    ui.showDesktopStub();
    throw new Error('Desktop is out of scope: open on a phone');
}

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
let routeQuery = '';   // текущий фильтр в списке маршрутов

/** Калибровка длины шага: копим пройденное по GPS, потом делим на число шагов. */
const IDLE_CALIBRATION = { active: false, awaiting: false, meters: 0, lastPoint: null };
let calibration = { ...IDLE_CALIBRATION };

/* ============================== Карта ============================== */

const mapView = createMapView({
    el: document.getElementById('map'),

    onMapClick(latlng) {
        if (!addMode) return;

        const place = store.addCheckpoint(latlng);
        if (!place) {
            ui.toast('Сначала выберите маршрут', 'warn');
            setAddMode(false);
            return;
        }

        // Режим добавления остаётся включённым: маршрут строится серией тапов.
        // Выключается кнопкой «Готово» в подсказке или той же плавающей кнопкой.
        ui.toast(`Добавлена точка «${place.name}»`, 'ok');
    },

    onCheckpointMoved(id, latlng) {
        store.updatePlace(id, latlng);
        ui.toast('Точка перемещена');
    },

    onTilesStateChange() {
        refreshNetworkChip();
    },

    // Карта сама отключила слежение, потому что её увели вручную.
    onFollowChange(next) {
        follow = next;
        store.setSetting('autoFollow', next);
        renderAll();   // кнопка ⌖ должна показать новое состояние
    },
});

mapView.setFollow(follow);

/* ============================== Позиция ============================== */

const tracker = createTracker({
    onUpdate(fix) {
        if (calibration.active) {
            if (calibration.lastPoint) calibration.meters += distance(calibration.lastPoint, fix);
            calibration.lastPoint = { lat: fix.lat, lng: fix.lng };
            renderCalibration();
        }

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
    },
});

/* ============================== Логика прохождения ============================== */

/**
 * Засчитывает точку, в радиус которой попал пользователь.
 *
 * Порядок не важен: проверяются все нерешённые точки маршрута, а не только
 * следующая по счёту. Если внутри радиуса оказалось несколько — берётся
 * ближайшая.
 *
 * Две защиты от ложных срабатываний:
 *  1. фикс с большой погрешностью игнорируется — иначе Wi-Fi-позиция с ±500 м
 *     «прошла» бы весь маршрут, не сходя с места;
 *  2. нужны два подряд фикса внутри радиуса, чтобы точка не переключалась
 *     туда-обратно на границе зоны.
 */
function evaluateArrival(fix) {
    let hit = null;
    let hitDistance = Infinity;

    for (const place of store.unresolvedPlaces()) {
        const d = distance(fix, place);
        if (d <= place.radius && d < hitDistance) {
            hit = place;
            hitDistance = d;
        }
    }

    if (!hit) {
        arrivalStreak = 0;
        streakTargetId = null;
        lowAccuracy = false;
        return;
    }

    if (fix.accuracy > accuracyLimitFor(hit.radius)) {
        lowAccuracy = true;
        arrivalStreak = 0;
        return;
    }
    lowAccuracy = false;

    if (hit.id !== streakTargetId) {
        streakTargetId = hit.id;
        arrivalStreak = 0;
    }

    arrivalStreak++;
    if (arrivalStreak < ARRIVAL_STREAK) return;

    arrivalStreak = 0;
    streakTargetId = null;
    const target = hit;
    if (!store.completeCheckpoint(target.id)) return;

    navigator.vibrate?.([40, 60, 120]);

    const stats = store.routeStats();
    if (stats.finished) {
        ui.toast(`Маршрут «${store.activeRoute().name}» пройден полностью! 🎉`, 'ok');
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
        routeName: store.activeRoute()?.name ?? null,
        places,
        statuses,
        stats: store.routeStats(),
        target: target ? { place: target, distance: lastFix ? distance(lastFix, target) : NaN } : null,
        distances,
        addMode,
        follow,
    });

    renderSteps();
    if (document.getElementById('routes-sheet').open) renderRoutesSheet();
}

function renderSteps() {
    const { heightCm, stepMeters } = store.getState().settings;
    ui.setSteps({
        heightCm,
        stepMeters: store.stepLength(),
        calibrated: stepMeters > 0,
    });
}

function renderCalibration() {
    ui.setCalibration({
        active: calibration.active,
        awaitingSteps: calibration.awaiting,
        meters: calibration.meters,
    });
}

function renderRoutesSheet() {
    const state = store.getState();
    ui.renderRoutes(store.searchRoutes(routeQuery), state.activeRouteId, (id) => store.routeStats(id));
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

            if (addMode) {
                requestWakeLock();
                ui.setDrawer('peek');   // освобождаем карту под расстановку точек
            } else if (store.activePlaces().length) {
                ui.setDrawer('half');   // закончили — показываем список и прогресс
            }
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

        onEditPlace(id, patch) {
            store.updatePlace(id, patch);
        },

        onSetPlaceState(id, next) {
            if (!store.setCheckpointState(id, next)) return;
            ui.invalidateList();
            ui.toast({
                completed: 'Точка отмечена пройденной',
                skipped: 'Точка пропущена',
                pending: 'Отметка снята',
            }[next] ?? 'Готово');
        },

        onHeightChange(value) {
            const cm = Math.round(Number(value));
            if (!Number.isFinite(cm) || cm < 100 || cm > 250) {
                ui.toast('Рост должен быть от 100 до 250 см', 'warn');
                renderSteps();
                return;
            }
            store.setSetting('heightCm', cm);
            ui.toast('Расстояния пересчитаны под ваш рост');
        },

        onCalibStart() {
            if (calibration.active) {
                // Завершение: дальше нужно только число шагов.
                if (calibration.meters < 20) {
                    calibration = { ...IDLE_CALIBRATION };
                    ui.toast('Слишком короткий отрезок — пройдите хотя бы 20 метров', 'warn');
                } else {
                    calibration = { ...calibration, active: false, awaiting: true, lastPoint: null };
                }
                renderCalibration();
                return;
            }

            if (!lastFix) {
                ui.toast('Нужен фикс GPS — подождите, пока индикатор позеленеет', 'warn');
                return;
            }

            calibration = {
                active: true,
                awaiting: false,
                meters: 0,
                lastPoint: { lat: lastFix.lat, lng: lastFix.lng },
            };
            requestWakeLock();
            renderCalibration();
            ui.toast('Идите по прямой и считайте шаги');
        },

        onCalibSave(value) {
            const steps = Math.round(Number(value));
            if (!Number.isFinite(steps) || steps < 5) {
                ui.toast('Введите число шагов — хотя бы пять', 'warn');
                return;
            }
            if (!store.calibrateStep(calibration.meters, steps)) {
                ui.toast('Не сходится: получается неправдоподобная длина шага', 'error');
                return;
            }
            calibration = { ...IDLE_CALIBRATION };
            renderCalibration();
            renderSteps();
            ui.toast('Длина шага уточнена по вашей ходьбе', 'ok');
        },

        onCalibReset() {
            store.resetStepCalibration();
            calibration = { ...IDLE_CALIBRATION };
            renderCalibration();
            ui.toast('Вернулись к оценке по росту');
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
            routeQuery = '';
            ui.clearRouteSearch();
            renderRoutesSheet();
            ui.openRoutesSheet();
        },

        onSearchRoutes(query) {
            routeQuery = query;
            renderRoutesSheet();
        },

        onSelectRoute(id) {
            store.selectRoute(id);
            ui.invalidateList();
            ui.closeRoutesSheet();

            const places = store.activePlaces();
            if (places.length) {
                mapView.fitRoute(places);
                ui.setDrawer('half');
            }
            ui.toast(`Маршрут «${store.activeRoute().name}» открыт`);
        },

        onNewRoute() {
            const name = prompt('Название маршрута:', 'Новый маршрут');
            if (name === null) return;

            const route = store.createRoute(name.trim() || 'Новый маршрут');
            ui.invalidateList();
            ui.closeRoutesSheet();
            setAddMode(true);
            ui.toast(`Создан «${route.name}» — тапайте по карте`, 'ok');
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
            if (!confirm(`Удалить маршрут «${name}» вместе с его точками и прогрессом? Это действие не отменить.`)) return;

            const wasActive = store.getState().activeRouteId === id;
            store.deleteRoute(id);
            ui.invalidateList();
            renderRoutesSheet();
            ui.toast(wasActive ? 'Маршрут удалён, выберите другой' : 'Маршрут удалён');
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

    // Ничего не активируем сами: маршрут выбирается явно, из списка.
    store.deselectRoute();

    renderAll();
    renderCalibration();
    refreshNetworkChip();

    tracker.start();

    setInterval(() => {
        if (lastFix) ui.setFixAge(Date.now() - lastFix.timestamp);
    }, TICK_MS);

    // Leaflet должен пересчитать размеры после смены раскладки drawer → сайдбар.
    window.matchMedia('(min-width: 900px)').addEventListener('change', () => mapView.invalidate());
    window.addEventListener('resize', () => mapView.invalidate());

    registerServiceWorker();
}

boot();
