/**
 * Источник позиции — геолокация браузера.
 *
 * Наружу отдаётся объект {lat, lng, accuracy, timestamp}. Опции слежения
 * жёстко заданы: высокая точность, без кэша, таймаут 15 секунд.
 *
 * Статусы: idle · insecure · requesting · live · stale · timeout · denied · unavailable
 */

const GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };

const STALE_AFTER_MS = 20000;  // после этого молчания фикс считается устаревшим
const WATCHDOG_MS = 1000;

export function createTracker({ onUpdate, onStatus }) {
    let watchId = null;
    let watchdogId = null;
    let status = 'idle';
    let lastFix = null;

    function setStatus(next, detail = null) {
        if (status === next && !detail) return;
        status = next;
        onStatus?.({ status: next, detail, lastFix });
    }

    /* ------------------------------ приём позиции ------------------------------ */

    function handlePosition(position) {
        const { latitude, longitude, accuracy } = position.coords;
        setStatus('live');

        lastFix = {
            lat: latitude,
            lng: longitude,
            accuracy: Number.isFinite(accuracy) ? accuracy : 9999,
            timestamp: position.timestamp || Date.now(),
        };
        onUpdate?.(lastFix);
    }

    function handleError(error) {
        switch (error.code) {
            case 1: // PERMISSION_DENIED
                // Chrome блокирует доступ и молча, если запрос несколько раз
                // проигнорировать, — поэтому подсказываем, где именно сбросить.
                setStatus('denied', 'Доступ к геопозиции запрещён. Нажмите значок настроек слева от адреса → «Сбросить разрешения» и перезагрузите страницу.');
                stop();
                break;

            case 2: // POSITION_UNAVAILABLE
                setStatus('unavailable', 'Устройство не может определить позицию. Проверьте, включена ли геолокация в настройках телефона.');
                break;

            case 3: // TIMEOUT
                // Не фатально: watchPosition продолжает работать и может выдать фикс позже.
                setStatus('timeout', 'Сигнал пока не поймали — ждём.');
                break;

            default:
                setStatus('unavailable', error.message || 'Неизвестная ошибка геолокации.');
        }
    }

    /* ------------------------------ управление слежением ------------------------------ */

    function start() {
        stop();

        if (!('geolocation' in navigator)) {
            setStatus('unavailable', 'Браузер не поддерживает геолокацию.');
            return;
        }

        // На http:// мобильный Chrome не отдаёт позицию и почти ничего не сообщает —
        // говорим об этом прямо, иначе поиск причины съедает часы.
        if (window.isSecureContext === false) {
            setStatus('insecure', 'Геолокация работает только на HTTPS. Откройте сайт по адресу, начинающемуся с https://');
            return;
        }

        setStatus('requesting');
        watchId = navigator.geolocation.watchPosition(handlePosition, handleError, GEO_OPTIONS);
    }

    function stop() {
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
    }

    /**
     * Сторожевой таймер.
     *
     * watchPosition в помещении и туннелях просто замолкает — без ошибки
     * и без новых фиксов. Без этой проверки интерфейс уверенно показывал бы
     * устаревшую позицию как свежую.
     */
    watchdogId = setInterval(() => {
        if (!lastFix || status !== 'live') return;
        if (Date.now() - lastFix.timestamp > STALE_AFTER_MS) setStatus('stale');
    }, WATCHDOG_MS);

    /* ------------------------------ публичный интерфейс ------------------------------ */

    return {
        get status() { return status; },
        get lastFix() { return lastFix; },

        start,

        /** Повторная попытка после отказа или потери сигнала. */
        retry: start,

        destroy() {
            stop();
            clearInterval(watchdogId);
        },
    };
}
