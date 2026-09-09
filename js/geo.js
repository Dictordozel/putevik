/**
 * Источник позиции: настоящий GPS и симуляция за одним интерфейсом.
 *
 * Наружу оба режима отдают одинаковый объект {lat, lng, accuracy, timestamp, simulated},
 * поэтому вся логика прохождения маршрута ниже не знает, откуда пришли координаты.
 *
 * Статусы: idle · insecure · requesting · live · stale · timeout · denied · unavailable · sim
 */

import { offset, bearing, distance } from './geodesy.js';
import { HOME_CENTER } from './config.js';

const GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };

const STALE_AFTER_MS = 20000;  // после этого молчания фикс считается устаревшим
const WATCHDOG_MS = 1000;
const SIM_ACCURACY = 5;
const WALK_SPEED_MPS = 1.4;    // ~5 км/ч
const WALK_TICK_MS = 500;
const ARRIVE_EPS_M = 3;

export function createTracker({ onUpdate, onStatus }) {
    let mode = 'real';           // 'real' | 'sim'
    let watchId = null;
    let watchdogId = null;
    let walkId = null;
    let status = 'idle';
    let lastFix = null;
    let simPos = null;
    let getWalkTarget = () => null;

    /* ------------------------------ статус ------------------------------ */

    function setStatus(next, detail = null) {
        if (status === next && !detail) return;
        status = next;
        onStatus?.({ status: next, detail, mode, lastFix });
    }

    function emit(fix) {
        lastFix = fix;
        onUpdate?.(fix);
    }

    /* ------------------------------ настоящий GPS ------------------------------ */

    function handlePosition(position) {
        const { latitude, longitude, accuracy } = position.coords;
        setStatus('live');
        emit({
            lat: latitude,
            lng: longitude,
            accuracy: Number.isFinite(accuracy) ? accuracy : 9999,
            timestamp: position.timestamp || Date.now(),
            simulated: false,
        });
    }

    function handleError(error) {
        switch (error.code) {
            case 1: // PERMISSION_DENIED
                // Chrome блокирует доступ и молча, если запрос несколько раз
                // проигнорировать, — поэтому подсказываем, где именно сбросить.
                setStatus('denied', 'Доступ к геопозиции запрещён. Нажмите значок настроек слева от адреса → «Сбросить разрешения», либо включите режим симуляции в разделе «Отладка».');
                stopReal();
                break;
            case 2: // POSITION_UNAVAILABLE
                setStatus('unavailable', 'Устройство не может определить позицию. Проверьте, включён ли GPS.');
                break;
            case 3: // TIMEOUT
                // Не фатально: watchPosition продолжает работать и может выдать фикс позже.
                setStatus('timeout', 'Сигнал пока не поймали — ждём.');
                break;
            default:
                setStatus('unavailable', error.message || 'Неизвестная ошибка геолокации.');
        }
    }

    function startReal() {
        stopReal();

        if (!('geolocation' in navigator)) {
            setStatus('unavailable', 'Браузер не поддерживает геолокацию. Доступен режим симуляции.');
            return;
        }

        // На http:// мобильный Chrome не отдаёт позицию и почти ничего не сообщает —
        // говорим об этом прямо, иначе поиск причины съедает часы.
        if (window.isSecureContext === false) {
            setStatus('insecure', 'Геолокация работает только на HTTPS или localhost. Откройте сайт по https:// либо включите режим симуляции.');
            return;
        }

        setStatus('requesting');
        watchId = navigator.geolocation.watchPosition(handlePosition, handleError, GEO_OPTIONS);
    }

    function stopReal() {
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
    }

    /* ------------------------------ симуляция ------------------------------ */

    function startSim(seed) {
        stopReal();
        simPos = seed || (lastFix ? { lat: lastFix.lat, lng: lastFix.lng } : { ...HOME_CENTER });
        setStatus('sim');
        pushSim();
    }

    function pushSim() {
        emit({
            lat: simPos.lat,
            lng: simPos.lng,
            accuracy: SIM_ACCURACY,
            timestamp: Date.now(),
            simulated: true,
        });
    }

    /** Телепортация — перетаскивание маркера мышью. */
    function teleport(latlng) {
        if (mode !== 'sim') return;
        simPos = { lat: latlng.lat, lng: latlng.lng };
        pushSim();
    }

    /** Шаг по азимуту — ходьба стрелками клавиатуры. */
    function nudge(bearingDeg, meters) {
        if (mode !== 'sim') return;
        simPos = offset(simPos, meters, bearingDeg);
        pushSim();
    }

    /* ------------------------------ автопроход ------------------------------ */

    function startWalk() {
        if (mode !== 'sim' || walkId) return false;

        walkId = setInterval(() => {
            const target = getWalkTarget();
            if (!target) {
                stopWalk();
                return;
            }
            const left = distance(simPos, target);
            const step = WALK_SPEED_MPS * (WALK_TICK_MS / 1000);

            simPos = left <= Math.max(step, ARRIVE_EPS_M)
                ? { lat: target.lat, lng: target.lng }
                : offset(simPos, step, bearing(simPos, target));

            pushSim();
        }, WALK_TICK_MS);

        return true;
    }

    function stopWalk() {
        clearInterval(walkId);
        walkId = null;
        onStatus?.({ status, detail: null, mode, lastFix, walking: false });
    }

    /* ------------------------------ сторожевой таймер ------------------------------ */

    /**
     * watchPosition в помещении и туннелях просто замолкает — без ошибки и без фиксов.
     * Без этой проверки интерфейс уверенно показывал бы устаревшую позицию как свежую.
     */
    function startWatchdog() {
        clearInterval(watchdogId);
        watchdogId = setInterval(() => {
            if (mode !== 'real' || !lastFix) return;
            const age = Date.now() - lastFix.timestamp;
            if (age > STALE_AFTER_MS && status === 'live') setStatus('stale');
        }, WATCHDOG_MS);
    }

    /* ------------------------------ клавиатура ------------------------------ */

    const BEARINGS = { ArrowUp: 0, ArrowRight: 90, ArrowDown: 180, ArrowLeft: 270 };

    function onKeyDown(event) {
        if (mode !== 'sim') return;
        if (!(event.key in BEARINGS)) return;

        // Не воруем стрелки у полей ввода и у списков.
        const tag = event.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;

        event.preventDefault();
        nudge(BEARINGS[event.key], event.shiftKey ? 50 : 10);
    }

    window.addEventListener('keydown', onKeyDown);

    /* ------------------------------ публичный интерфейс ------------------------------ */

    startWatchdog();

    return {
        get mode() { return mode; },
        get status() { return status; },
        get lastFix() { return lastFix; },
        get isWalking() { return walkId !== null; },

        start() {
            mode === 'sim' ? startSim(simPos) : startReal();
        },

        setMode(next, seed) {
            if (next === mode) return;
            stopWalk();
            mode = next;
            if (next === 'sim') startSim(seed);
            else {
                simPos = null;
                startReal();
            }
        },

        /** Повторная попытка после отказа или потери сигнала. */
        retry() {
            if (mode === 'real') startReal();
        },

        teleport,
        nudge,

        /** Приложение сообщает, куда идти в автопроходе (следующая непройденная точка). */
        setWalkTargetSource(fn) {
            getWalkTarget = fn;
        },

        toggleWalk() {
            return walkId ? (stopWalk(), false) : startWalk();
        },

        stopWalk,

        destroy() {
            stopReal();
            stopWalk();
            clearInterval(watchdogId);
            window.removeEventListener('keydown', onKeyDown);
        },
    };
}
