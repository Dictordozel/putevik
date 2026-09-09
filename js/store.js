/**
 * Состояние приложения — единственный источник истины.
 *
 * Модель: справочник мест (объектов) + библиотека маршрутов, ссылающихся на места
 * по id. Прогресс хранится отдельно по каждому маршруту, поэтому одно и то же
 * место, попавшее в два маршрута, не «проходится» в обоих сразу.
 *
 * Статус точки (pending / next / completed / skipped) нигде не хранится — он вычисляется
 * из progress[routeId].completedIds и позиции точки в последовательности.
 */

import { pathLength, segmentLengths, stepFromHeight, DEFAULT_HEIGHT_CM } from './geodesy.js';

const KEY = 'putevik.v1';
const VERSION = 1;
const SAVE_DEBOUNCE_MS = 300;

export const KINDS = {
    start: { label: 'Точка входа', icon: '🚩' },
    sight: { label: 'Достопримечательность', icon: '📍' },
    rest: { label: 'Привал', icon: '☕' },
    finish: { label: 'Финиш', icon: '🏁' },
    custom: { label: 'Другое', icon: '•' },
};

/* ============================== Служебное ============================== */

const now = () => Date.now();

function uid(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 8)}${now().toString(36).slice(-3)}`;
}

function defaultState() {
    return {
        version: VERSION,
        places: {},
        routes: [],
        activeRouteId: null,
        progress: {},
        settings: {
            autoFollow: true,
            defaultRadius: 20,
            heightCm: DEFAULT_HEIGHT_CM,
            stepMeters: null,   // задаётся калибровкой; null — считаем по росту
        },
    };
}

/** Приведение прочитанного состояния к текущей версии. */
function migrate(raw) {
    const state = { ...defaultState(), ...raw };
    state.version = VERSION;

    // Страховка от частично битых данных: любое поле не того типа заменяем дефолтом.
    if (!state.places || typeof state.places !== 'object') state.places = {};
    // Пустой список маршрутов — законное состояние: всё удалили.
    if (!Array.isArray(state.routes)) state.routes = [];
    if (!state.progress || typeof state.progress !== 'object') state.progress = {};
    state.settings = { ...defaultState().settings, ...(state.settings || {}) };

    // Выбрасываем ссылки на несуществующие места и несуществующий активный маршрут.
    for (const route of state.routes) {
        route.placeIds = (route.placeIds || []).filter((id) => state.places[id]);
    }
    if (!state.routes.some((r) => r.id === state.activeRouteId)) {
        state.activeRouteId = null;
    }
    return state;
}

function isPlaceLike(p) {
    return p && typeof p === 'object' &&
        Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
        p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
}

/* ============================== Загрузка ============================== */

function load() {
    let raw;
    try {
        raw = localStorage.getItem(KEY);
    } catch {
        // Приватный режим или запрет на хранилище — работаем без персистентности.
        return { state: defaultState(), warning: 'storage-unavailable' };
    }
    if (!raw) return { state: defaultState(), warning: null };

    try {
        return { state: migrate(JSON.parse(raw)), warning: null };
    } catch {
        // Битый JSON не должен ронять приложение. Копию сохраняем — вдруг понадобится.
        try {
            localStorage.setItem(`${KEY}.broken.${now()}`, raw);
        } catch { /* некуда сохранить — не критично */ }
        return { state: defaultState(), warning: 'data-corrupt' };
    }
}

const loaded = load();

/* ============================== Ядро ============================== */

let state = loaded.state;
const listeners = new Set();
let saveTimer = null;
let storageBlocked = loaded.warning === 'storage-unavailable';

export const initialWarning = loaded.warning;

function notify() {
    for (const fn of listeners) {
        try {
            fn(state);
        } catch (err) {
            console.error('Ошибка подписчика store:', err);
        }
    }
}

/** Немедленная запись в LocalStorage. */
export function flush() {
    if (storageBlocked) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch (err) {
        storageBlocked = true;
        console.warn('Не удалось сохранить состояние:', err);
        onStorageError?.(err);
    }
}

let onStorageError = null;
export function setStorageErrorHandler(fn) {
    onStorageError = fn;
}

/**
 * Фиксация изменений: подписчики получают новое состояние сразу,
 * а запись на диск отложена — watchPosition дёргает состояние часто.
 */
function commit() {
    notify();
    if (storageBlocked) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
}

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function getState() {
    return state;
}

// Мобильный браузер может убить вкладку без предупреждения — досохраняем заранее.
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
});

/* ============================== Выборки ============================== */

/**
 * Активный маршрут или null.
 *
 * При запуске ничего не активируется само: пользователь выбирает маршрут
 * явно, поэтому null здесь — нормальное состояние, а не ошибка.
 */
export function activeRoute() {
    return state.routes.find((r) => r.id === state.activeRouteId) ?? null;
}

/** Места активного маршрута в порядке прохождения. */
export function activePlaces() {
    const route = activeRoute();
    if (!route) return [];
    return route.placeIds.map((id) => state.places[id]).filter(Boolean);
}

function progressFor(routeId) {
    const p = state.progress[routeId];
    return {
        completedIds: p?.completedIds ?? [],
        skippedIds: p?.skippedIds ?? [],
        startedAt: p?.startedAt ?? null,
        lastAt: p?.lastAt ?? null,
    };
}

/** Точка «решена», если пройдена или пропущена: цель дальше её не ждёт. */
function resolvedIds(routeId) {
    const p = progressFor(routeId);
    return new Set([...p.completedIds, ...p.skippedIds]);
}

export function activeProgress() {
    return progressFor(state.activeRouteId);
}

/**
 * Статусы точек активного маршрута.
 * Порядок здесь только подсказка: 'next' получает первая нерешённая точка.
 */
export function statuses() {
    const places = activePlaces();
    const progress = activeProgress();
    const done = new Set(progress.completedIds);
    const skipped = new Set(progress.skippedIds);
    let nextAssigned = false;

    return places.map((place) => {
        if (done.has(place.id)) return 'completed';
        if (skipped.has(place.id)) return 'skipped';
        // Порядок остаётся подсказкой: целью становится первая нерешённая точка,
        // но засчитать можно любую — блокировки больше нет.
        if (!nextAssigned) {
            nextAssigned = true;
            return 'next';
        }
        return 'pending';
    });
}

/** Первая непройденная точка активного маршрута либо null, если маршрут завершён. */
export function nextTarget() {
    const places = activePlaces();
    const i = statuses().indexOf('next');
    return i === -1 ? null : places[i];
}

/** Точки, которые ещё можно засчитать: ни пройденные, ни пропущенные. */
export function unresolvedPlaces() {
    const resolved = resolvedIds(state.activeRouteId);
    return activePlaces().filter((place) => !resolved.has(place.id));
}

/**
 * Точка возврата на маршрут: последняя пройденная, а если таких нет — старт.
 * От неё строится подводящий путь, когда пользователь оказался в стороне.
 */
export function rejoinPoint() {
    const places = activePlaces();
    if (places.length === 0) return null;


    const completed = activeProgress().completedIds;
    for (let i = places.length - 1; i >= 0; i--) {
        if (completed.includes(places[i].id)) return places[i];
    }
    return places[0];
}

/**
 * Сводка по активному маршруту.
 * Процент считается по длине: сумма участков между подряд пройденными точками.
 */
export function routeStats(routeId = state.activeRouteId) {
    const route = state.routes.find((r) => r.id === routeId);
    if (!route) return { total: 0, done: 0, left: 0, percent: 0, count: 0, completedCount: 0 };

    const places = route.placeIds.map((id) => state.places[id]).filter(Boolean);
    const progress = progressFor(routeId);
    const doneSet = new Set(progress.completedIds);
    const skippedSet = new Set(progress.skippedIds);
    // Участок засчитывается, если решены оба его конца: пропуск точки
    // не должен навсегда оставлять маршрут незавершённым.
    const resolved = new Set([...doneSet, ...skippedSet]);

    const total = pathLength(places);
    const segments = segmentLengths(places);

    let done = 0;
    for (let i = 1; i < places.length; i++) {
        if (resolved.has(places[i - 1].id) && resolved.has(places[i].id)) done += segments[i - 1];
    }

    const completedCount = places.filter((p) => doneSet.has(p.id)).length;
    const skippedCount = places.filter((p) => skippedSet.has(p.id)).length;
    const resolvedCount = completedCount + skippedCount;

    // Одна точка длины не имеет — тогда процент считаем по количеству.
    const percent = total > 0
        ? Math.min(100, Math.round((done / total) * 100))
        : (places.length ? Math.round((resolvedCount / places.length) * 100) : 0);

    return {
        total,
        done,
        left: Math.max(0, total - done),
        percent,
        count: places.length,
        completedCount,
        skippedCount,
        finished: places.length > 0 && resolvedCount === places.length,
    };
}

/* ============================== Действия: точки ============================== */

/** Создаёт место и добавляет его в конец активного маршрута. */
export function addCheckpoint({ lat, lng }) {
    const route = activeRoute();
    if (!route) return null;

    const isFirst = route.placeIds.length === 0;
    const place = {
        id: uid('pl'),
        name: isFirst ? 'Старт' : `Точка ${route.placeIds.length + 1}`,
        note: '',
        kind: isFirst ? 'start' : 'sight',
        lat,
        lng,
        radius: state.settings.defaultRadius,
        createdAt: now(),
    };

    state.places[place.id] = place;
    route.placeIds.push(place.id);
    route.updatedAt = now();
    commit();
    return place;
}

export function updatePlace(id, patch) {
    const place = state.places[id];
    if (!place) return;

    if ('name' in patch) place.name = String(patch.name).slice(0, 60);
    if ('note' in patch) place.note = String(patch.note).slice(0, 300);
    if ('kind' in patch && patch.kind in KINDS) place.kind = patch.kind;
    if ('radius' in patch) {
        const r = Number(patch.radius);
        if (Number.isFinite(r)) place.radius = Math.min(500, Math.max(5, Math.round(r)));
    }
    if ('lat' in patch && 'lng' in patch && isPlaceLike(patch)) {
        place.lat = patch.lat;
        place.lng = patch.lng;
    }

    const route = activeRoute();
    if (route) route.updatedAt = now();
    commit();
}

export function removeCheckpoint(id) {
    const route = activeRoute();
    if (!route) return;

    route.placeIds = route.placeIds.filter((pid) => pid !== id);
    route.updatedAt = now();

    const progress = state.progress[route.id];
    if (progress) {
        progress.completedIds = progress.completedIds.filter((pid) => pid !== id);
        progress.skippedIds = (progress.skippedIds ?? []).filter((pid) => pid !== id);
    }

    gcPlaces();
    commit();
}

/** Сдвигает точку по маршруту: direction -1 — выше, +1 — ниже. */
export function moveCheckpoint(id, direction) {
    const route = activeRoute();
    if (!route) return;

    const from = route.placeIds.indexOf(id);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= route.placeIds.length) return;

    [route.placeIds[from], route.placeIds[to]] = [route.placeIds[to], route.placeIds[from]];
    route.updatedAt = now();
    commit();
}

/* ============================== Действия: прогресс ============================== */

/** Отмечает точку пройденной. Возвращает true, если статус изменился. */
function ensureProgress(routeId) {
    return state.progress[routeId] ||
        (state.progress[routeId] = { completedIds: [], skippedIds: [], startedAt: now(), lastAt: null });
}

/**
 * Состояние точки: 'completed' — пройдена, 'skipped' — пропущена,
 * 'pending' — снова не пройдена. Возвращает true, если что-то изменилось.
 *
 * Порядок не проверяется: засчитать или отметить можно любую точку маршрута.
 */
export function setCheckpointState(placeId, next) {
    if (!state.activeRouteId) return false;

    const progress = ensureProgress(state.activeRouteId);
    if (!progress.skippedIds) progress.skippedIds = [];

    const current = progress.completedIds.includes(placeId)
        ? 'completed'
        : (progress.skippedIds.includes(placeId) ? 'skipped' : 'pending');

    if (current === next) return false;

    progress.completedIds = progress.completedIds.filter((id) => id !== placeId);
    progress.skippedIds = progress.skippedIds.filter((id) => id !== placeId);

    if (next === 'completed') progress.completedIds.push(placeId);
    if (next === 'skipped') progress.skippedIds.push(placeId);

    progress.lastAt = now();
    if (!progress.startedAt) progress.startedAt = now();
    commit();
    return true;
}

/** Засчитать точку пройденной. */
export function completeCheckpoint(placeId) {
    return setCheckpointState(placeId, 'completed');
}

export function resetProgress(routeId = state.activeRouteId) {
    delete state.progress[routeId];
    commit();
}

export function clearActiveRoute() {
    const route = activeRoute();
    if (!route) return;

    route.placeIds = [];
    route.updatedAt = now();
    delete state.progress[route.id];
    gcPlaces();
    commit();
}

/* ============================== Действия: маршруты ============================== */

export function createRoute(name = 'Новый маршрут') {
    const route = { id: uid('rt'), name, placeIds: [], createdAt: now(), updatedAt: now() };
    state.routes.push(route);
    state.activeRouteId = route.id;
    commit();
    return route;
}

export function selectRoute(id) {
    if (!state.routes.some((r) => r.id === id)) return;
    state.activeRouteId = id;
    commit();
}

/** Снять выбор — состояние «маршрут не выбран». */
export function deselectRoute() {
    state.activeRouteId = null;
    commit();
}

/**
 * Поиск маршрута по названию и по названиям точек внутри него:
 * название забывается быстрее, чем то, что на маршруте было.
 */
export function searchRoutes(query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return state.routes;

    return state.routes.filter((route) => {
        if (route.name.toLowerCase().includes(q)) return true;
        return route.placeIds.some((id) => {
            const place = state.places[id];
            return place && (
                place.name.toLowerCase().includes(q) ||
                place.note.toLowerCase().includes(q)
            );
        });
    });
}

export function renameRoute(id, name) {
    const route = state.routes.find((r) => r.id === id);
    if (!route) return;
    route.name = String(name).slice(0, 60) || 'Без названия';
    route.updatedAt = now();
    commit();
}

export function duplicateRoute(id) {
    const source = state.routes.find((r) => r.id === id);
    if (!source) return null;

    // Копия получает собственные места: правка названия в копии не должна
    // менять оригинальный маршрут.
    const placeIds = source.placeIds.map((pid) => {
        const copy = { ...state.places[pid], id: uid('pl'), createdAt: now() };
        state.places[copy.id] = copy;
        return copy.id;
    });

    const route = {
        id: uid('rt'),
        name: `${source.name} (копия)`,
        placeIds,
        createdAt: now(),
        updatedAt: now(),
    };
    state.routes.push(route);
    commit();
    return route;
}

/**
 * Удаляет маршрут вместе с его прогрессом.
 *
 * Последний маршрут теперь тоже удаляется: пустой список — законное
 * состояние, приложение показывает «Выберите маршрут» и предлагает создать.
 */
export function deleteRoute(id) {
    state.routes = state.routes.filter((r) => r.id !== id);
    delete state.progress[id];
    if (state.activeRouteId === id) state.activeRouteId = null;
    gcPlaces();
    commit();
}

/** Удаляет места, на которые не ссылается ни один маршрут. */
function gcPlaces() {
    const used = new Set(state.routes.flatMap((r) => r.placeIds));
    for (const id of Object.keys(state.places)) {
        if (!used.has(id)) delete state.places[id];
    }
}

/* ============================== Настройки ============================== */

/**
 * Длина шага в метрах: результат калибровки, если она была,
 * иначе оценка по росту.
 */
export function stepLength() {
    const { stepMeters, heightCm } = state.settings;
    return stepMeters > 0 ? stepMeters : stepFromHeight(heightCm);
}

/** Калибровка: реальная длина шага из пройденного расстояния и числа шагов. */
export function calibrateStep(meters, steps) {
    const value = Number(meters) / Number(steps);
    if (!Number.isFinite(value) || value < 0.3 || value > 1.5) return false;
    state.settings.stepMeters = value;
    commit();
    return true;
}

/** Сброс калибровки — возвращаемся к оценке по росту. */
export function resetStepCalibration() {
    state.settings.stepMeters = null;
    commit();
}

export function setSetting(key, value) {
    state.settings[key] = value;
    commit();
}

/* ============================== Экспорт и импорт ============================== */

export function exportJSON() {
    return JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
}

/**
 * Импорт добавляет маршруты к существующим, а не затирает их.
 * Все id пересоздаются, поэтому совпадение id из другого устройства
 * не может перезаписать локальные данные.
 */
export function importJSON(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new Error('Файл не похож на выгрузку Путевика');
    if (!Array.isArray(data.routes) || !data.places || typeof data.places !== 'object') {
        throw new Error('В файле нет маршрутов и мест');
    }

    const idMap = new Map();
    let importedPlaces = 0;

    for (const [oldId, place] of Object.entries(data.places)) {
        if (!isPlaceLike(place)) continue;
        const copy = {
            id: uid('pl'),
            name: String(place.name ?? 'Точка').slice(0, 60),
            note: String(place.note ?? '').slice(0, 300),
            kind: place.kind in KINDS ? place.kind : 'sight',
            lat: place.lat,
            lng: place.lng,
            radius: Number.isFinite(place.radius) ? Math.min(500, Math.max(5, place.radius)) : 20,
            createdAt: Number.isFinite(place.createdAt) ? place.createdAt : now(),
        };
        state.places[copy.id] = copy;
        idMap.set(oldId, copy.id);
        importedPlaces++;
    }

    let importedRoutes = 0;
    let firstId = null;

    for (const route of data.routes) {
        const placeIds = (route.placeIds || []).map((pid) => idMap.get(pid)).filter(Boolean);
        if (placeIds.length === 0) continue;

        const copy = {
            id: uid('rt'),
            name: `${String(route.name ?? 'Маршрут').slice(0, 55)} (импорт)`,
            placeIds,
            createdAt: Number.isFinite(route.createdAt) ? route.createdAt : now(),
            updatedAt: now(),
        };
        state.routes.push(copy);

        // Прогресс переносим, если он был в файле.
        const sourceProgress = data.progress?.[route.id];
        if (sourceProgress?.completedIds?.length) {
            state.progress[copy.id] = {
                completedIds: sourceProgress.completedIds.map((pid) => idMap.get(pid)).filter(Boolean),
                startedAt: sourceProgress.startedAt ?? now(),
                lastAt: sourceProgress.lastAt ?? null,
            };
        }

        if (!firstId) firstId = copy.id;
        importedRoutes++;
    }

    if (!importedRoutes) {
        gcPlaces();
        commit();
        throw new Error('Не удалось прочитать ни один маршрут');
    }

    state.activeRouteId = firstId;
    gcPlaces();
    commit();
    return { routes: importedRoutes, places: importedPlaces };
}
