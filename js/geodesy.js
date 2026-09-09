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

/** «12 с», «3 мин» — возраст последнего фикса. */
export function formatAge(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec} с`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} мин`;
    return `${Math.round(min / 60)} ч`;
}
