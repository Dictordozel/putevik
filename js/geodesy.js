/**
 * Геометрия на сфере и форматирование расстояний.
 * Модуль без состояния — только чистые функции.
 */

const R = 6371e3; // средний радиус Земли, м
const RAD = Math.PI / 180;

/** Расстояние между двумя точками по формуле гаверсинусов, м. */
export function distance(a, b) {
    const phi1 = a.lat * RAD;
    const phi2 = b.lat * RAD;
    const dPhi = (b.lat - a.lat) * RAD;
    const dLambda = (b.lng - a.lng) * RAD;

    const h = Math.sin(dPhi / 2) ** 2 +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;

    return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Длина ломаной по списку точек, м. */
export function pathLength(points) {
    let sum = 0;
    for (let i = 1; i < points.length; i++) sum += distance(points[i - 1], points[i]);
    return sum;
}

/** Длины отдельных участков между соседними точками, м. */
export function segmentLengths(points) {
    const out = [];
    for (let i = 1; i < points.length; i++) out.push(distance(points[i - 1], points[i]));
    return out;
}

/** «120 м», «1,4 км» — человекочитаемое расстояние. */
export function formatDistance(meters) {
    if (!Number.isFinite(meters)) return '—';
    if (meters < 1000) return `${Math.round(meters)} м`;
    if (meters < 10000) return `${(meters / 1000).toFixed(1).replace('.', ',')} км`;
    return `${Math.round(meters / 1000)} км`;
}

/* ============================== Шаги ============================== */

/**
 * Средняя длина шага оценивается как рост × 0.415 — общепринятый коэффициент
 * для спокойной ходьбы. Оценка грубая, поэтому её можно уточнить калибровкой:
 * пройти отрезок, посчитать свои шаги и разделить пройденное на их число.
 */
export const STEP_FACTOR = 0.415;
export const DEFAULT_HEIGHT_CM = 175;

export function stepFromHeight(heightCm) {
    const h = Number(heightCm);
    if (!Number.isFinite(h) || h < 100 || h > 250) return (DEFAULT_HEIGHT_CM * STEP_FACTOR) / 100;
    return (h * STEP_FACTOR) / 100;
}

/** Русское склонение после числительного. */
function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}

export function toSteps(meters, stepMeters) {
    if (!Number.isFinite(meters) || !(stepMeters > 0)) return NaN;
    return meters / stepMeters;
}

/**
 * «≈ 620 шагов» — основная единица интерфейса.
 * Метры остаются внутри для расчётов, наружу выходят шаги.
 */
export function formatSteps(meters, stepMeters) {
    const steps = toSteps(meters, stepMeters);
    if (!Number.isFinite(steps)) return '—';

    const rounded = steps < 100 ? Math.round(steps) : Math.round(steps / 10) * 10;
    const word = plural(rounded, 'шаг', 'шага', 'шагов');
    return `≈ ${rounded.toLocaleString('ru-RU')} ${word}`;
}

/** «12 с», «3 мин» — возраст последнего фикса. */
export function formatAge(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec} с`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} мин`;
    return `${Math.round(min / 60)} ч`;
}
