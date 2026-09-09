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

/**
 * Смещение точки на заданное расстояние по азимуту — нужно режиму симуляции,
 * чтобы «шаг стрелкой» был честными 10 метрами на любой широте.
 * @param {{lat:number,lng:number}} from
 * @param {number} meters
 * @param {number} bearingDeg 0 — север, 90 — восток
 */
export function offset(from, meters, bearingDeg) {
    const delta = meters / R;
    const theta = bearingDeg * RAD;
    const phi1 = from.lat * RAD;
    const lambda1 = from.lng * RAD;

    const sinPhi2 = Math.sin(phi1) * Math.cos(delta) +
        Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
    const phi2 = Math.asin(Math.min(1, Math.max(-1, sinPhi2)));

    const lambda2 = lambda1 + Math.atan2(
        Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
        Math.cos(delta) - Math.sin(phi1) * sinPhi2
    );

    return {
        lat: phi2 / RAD,
        lng: ((lambda2 / RAD + 540) % 360) - 180, // нормализация в [-180, 180)
    };
}

/** Азимут из точки a в точку b, градусы. */
export function bearing(a, b) {
    const phi1 = a.lat * RAD;
    const phi2 = b.lat * RAD;
    const dLambda = (b.lng - a.lng) * RAD;

    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) -
        Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);

    return (Math.atan2(y, x) / RAD + 360) % 360;
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
