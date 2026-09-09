/**
 * Прокладка пешего маршрута по улицам через openrouteservice.
 *
 * Модуль умеет ровно одно: превратить список точек в геометрию дороги.
 * Что делать при отказе сервиса, когда пересчитывать и где хранить результат —
 * решает вызывающий код; здесь только запрос и разбор ответа.
 */

import { ORS_KEY, ORS_URL, ORS_MAX_POINTS } from './config.js';

/**
 * Подпись координат маршрута.
 *
 * По ней видно, что сохранённая геометрия устарела: точку подвинули,
 * добавили или переставили — подпись изменилась, дорогу надо перепроложить.
 * Пяти знаков после запятой хватает: это около метра на местности.
 */
export function pathSignature(points) {
    return points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(';');
}

/** Ошибка прокладки с человеческим текстом для интерфейса. */
export class RoutingError extends Error {
    constructor(message, kind) {
        super(message);
        this.name = 'RoutingError';
        this.kind = kind;   // 'limit' | 'network' | 'service' | 'input'
    }
}

/**
 * Запрашивает пеший маршрут через все точки по порядку.
 *
 * @returns {Promise<{geometry: Array<[number, number]>, wayPoints: number[],
 *                    legs: number[], total: number, signature: string, computedAt: number}>}
 */
export async function fetchWalkingPath(points, { signal } = {}) {
    if (points.length < 2) {
        throw new RoutingError('Для прокладки нужны хотя бы две точки', 'input');
    }
    if (points.length > ORS_MAX_POINTS) {
        throw new RoutingError(`Сервис принимает не больше ${ORS_MAX_POINTS} точек за раз`, 'input');
    }

    let response;
    try {
        response = await fetch(ORS_URL, {
            method: 'POST',
            headers: {
                Authorization: ORS_KEY,
                'Content-Type': 'application/json',
                Accept: 'application/geo+json',
            },
            // Сервис ждёт [долгота, широта] — порядок обратный привычному.
            body: JSON.stringify({ coordinates: points.map((p) => [p.lng, p.lat]) }),
            signal,
        });
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new RoutingError('Нет связи с сервисом маршрутов', 'network');
    }

    if (response.status === 429) {
        throw new RoutingError('Дневной лимит запросов к сервису исчерпан', 'limit');
    }
    if (!response.ok) {
        throw new RoutingError(`Сервис маршрутов ответил ${response.status}`, 'service');
    }

    const data = await response.json();
    const feature = data?.features?.[0];
    if (!feature?.geometry?.coordinates?.length) {
        throw new RoutingError('Сервис не смог проложить путь между этими точками', 'service');
    }

    const props = feature.properties ?? {};

    return {
        // Leaflet ждёт [широта, долгота], GeoJSON отдаёт наоборот.
        geometry: feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        // Индексы исходных точек внутри геометрии: по ним режем пройденную часть.
        wayPoints: props.way_points ?? [],
        legs: (props.segments ?? []).map((seg) => seg.distance),
        total: props.summary?.distance ?? 0,
        signature: pathSignature(points),
        computedAt: Date.now(),
    };
}

/** Годится ли сохранённая геометрия для текущего набора точек. */
export function isPathFresh(path, points) {
    return Boolean(path) && path.signature === pathSignature(points);
}
