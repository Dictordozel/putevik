/**
 * Всё, что касается Leaflet: слои, маркеры, линии маршрута, деградация тайлов.
 *
 * Ключевая идея: тайлы и векторные слои независимы. Когда сеть пропадает,
 * подложка гаснет, но точки, круги радиусов и линии маршрута продолжают
 * рисоваться — приложение остаётся рабочим, а не превращается в белое пятно.
 */

import { HOME_LATLNG, HOME_ZOOM } from './config.js';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const TILE_ERROR_LIMIT = 6;       // столько ошибок подряд — считаем подложку недоступной
const TILE_ERROR_WINDOW_MS = 8000;

const COLORS = {
    route: '#64748b',      // сам «рисунок» маршрута — виден всегда
    leadIn: '#7c3aed',     // подводящий путь: это подсказка, а не часть маршрута
    pending: '#94a3b8',
    skipped: '#94a3b8',
    next: '#1b6ef3',
    completed: '#16a34a',
};

/** Пройденная и пропущенная точки одинаково «решены»: участок за ними закрыт. */
const isResolved = (status) => status === 'completed' || status === 'skipped';


export function createMapView({ el, onMapClick, onCheckpointMoved, onTilesStateChange, onFollowChange }) {
    const map = L.map(el, {
        zoomControl: false,
        attributionControl: true,
    }).setView(HOME_LATLNG, HOME_ZOOM);

    // Кнопки зума нужны мышке; на тач-устройствах хватает щипка, а место дороже.
    if (window.matchMedia('(pointer: fine)').matches) {
        L.control.zoom({ position: 'bottomleft' }).addTo(map);
    }

    const tiles = L.tileLayer(TILE_URL, {
        maxZoom: 19,
        minZoom: 3,
        attribution: TILE_ATTRIBUTION,
        // Нужен, чтобы Service Worker кэшировал тайлы как обычные CORS-ответы:
        // непрозрачные ответы нельзя проверить и они занимают больше места.
        crossOrigin: 'anonymous',
        keepBuffer: 4,       // чуть больший буфер = меньше «дыр» при офлайн-панорамировании
    }).addTo(map);

    /* ------------------------------ слои ------------------------------ */

    // Порядок добавления = порядок отрисовки. Сначала весь маршрут целиком,
    // поверх него подсветка пройденного, сверху — пунктир до следующей цели.
    const routeLine = L.polyline([], {
        color: COLORS.route, weight: 5, opacity: .95, lineCap: 'round', lineJoin: 'round',
    }).addTo(map);

    const doneLine = L.polyline([], {
        color: COLORS.completed, weight: 6, opacity: .95, lineCap: 'round', lineJoin: 'round',
    }).addTo(map);

    const legLine = L.polyline([], {
        color: COLORS.next, weight: 3, opacity: .9, dashArray: '2 8', lineCap: 'round',
    }).addTo(map);

    // Путь возвращения на маршрут: другой цвет и штрих, чтобы его нельзя было
    // спутать с самим маршрутом.
    const leadInLine = L.polyline([], {
        color: COLORS.leadIn, weight: 4, opacity: .9, dashArray: '10 7', lineCap: 'round',
    }).addTo(map);

    const cpLayer = L.layerGroup().addTo(map);

    let userMarker = null;
    let accuracyCircle = null;
    let follow = true;
    let hasCenteredOnUser = false;

    /* ------------------------------ деградация тайлов ------------------------------ */

    let tileErrors = [];
    let tilesDown = false;

    function setTilesDown(next) {
        if (tilesDown === next) return;
        tilesDown = next;
        el.classList.toggle('tiles-down', next);
        onTilesStateChange?.(next);
    }

    tiles.on('tileerror', () => {
        const now = Date.now();
        tileErrors = tileErrors.filter((t) => now - t < TILE_ERROR_WINDOW_MS);
        tileErrors.push(now);
        if (tileErrors.length >= TILE_ERROR_LIMIT) setTilesDown(true);
    });

    tiles.on('tileload', () => {
        tileErrors = [];
        setTilesDown(false);
    });

    /* ------------------------------ клик по карте ------------------------------ */

    map.on('click', (event) => onMapClick?.({ lat: event.latlng.lat, lng: event.latlng.lng }));

    /**
     * Ручное панорамирование выключает слежение за позицией.
     *
     * Без этого каждый следующий фикс GPS возвращал карту к пользователю:
     * стоит увести её, чтобы поставить точку в стороне, и через секунду
     * она перескакивает обратно. Событие dragstart возникает только от
     * жеста пользователя — программный panTo его не вызывает, поэтому
     * само слежение себя не выключает.
     */
    map.on('dragstart', () => {
        if (!follow) return;
        follow = false;
        onFollowChange?.(false);
    });

    /* ------------------------------ отрисовка маршрута ------------------------------ */

    function markerIcon(index, status) {
        // На карте важен порядок прохождения, поэтому в маркере номер,
        // а тип места показывает список в панели.
        const glyph = status === 'completed' ? '✓' : (status === 'skipped' ? '×' : index + 1);
        return L.divIcon({
            className: '',   // Leaflet иначе подмешивает свои отступы
            html: `<div class="cp-marker cp-marker--${status}"><span>${glyph}</span></div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 30],
            popupAnchor: [0, -28],
        });
    }

    let routeSignature = '';

    /**
     * Перерисовывает маршрут целиком — для прототипа это надёжнее точечной
     * синхронизации слоёв. Но только когда что-то действительно изменилось:
     * renderRoute вызывается на каждом фиксе GPS, а пересоздание маркеров
     * посреди перетаскивания точки этот жест обрывает.
     */
    function renderRoute(places, statuses, path = null) {
        const signature = places
            .map((p, i) => `${p.id}:${p.lat.toFixed(6)}:${p.lng.toFixed(6)}:${p.radius}:${p.name}:${p.note}:${statuses[i]}`)
            .join('|') + `#${path?.computedAt ?? 'straight'}`;

        if (signature === routeSignature) return;
        routeSignature = signature;

        cpLayer.clearLayers();

        places.forEach((place, i) => {
            const status = statuses[i] ?? 'pending';
            const latlng = [place.lat, place.lng];

            L.circle(latlng, {
                radius: place.radius,
                color: COLORS[status] ?? COLORS.pending,
                fillColor: COLORS[status] ?? COLORS.pending,
                fillOpacity: status === 'completed' ? .18 : .12,
                weight: 1.5,
                interactive: false,   // круг не должен перехватывать тап по карте
            }).addTo(cpLayer);

            const marker = L.marker(latlng, {
                icon: markerIcon(i, status),
                draggable: true,
                autoPan: true,
                keyboard: false,
                title: place.name,
            }).addTo(cpLayer);

            marker.bindPopup(
                `<strong>${escapeHtml(place.name)}</strong>` +
                (place.note ? `<br>${escapeHtml(place.note)}` : '') +
                `<br><small>радиус ${place.radius} м</small>`
            );

            marker.on('dragend', (event) => {
                const { lat, lng } = event.target.getLatLng();
                onCheckpointMoved?.(place.id, { lat, lng });
            });
        });

        // Маршрут рисуется целиком и не меняется по мере прохождения — это его
        // «рисунок». Прогресс показывается отдельной линией поверх, поэтому
        // исчезать нечему: участок либо подсвечен, либо просто не подсвечен.
        const straight = places.map((p) => [p.lat, p.lng]);
        const usable = path?.geometry?.length && path.wayPoints?.length === places.length;

        routeLine.setLatLngs(usable ? path.geometry : straight);
        doneLine.setLatLngs(
            usable ? doneAlongRoad(path, statuses) : doneStraight(straight, statuses)
        );
    }

    /** Пройденные участки прямыми — когда дороги нет. */
    function doneStraight(latlngs, statuses) {
        const out = [];
        for (let i = 1; i < latlngs.length; i++) {
            if (isResolved(statuses[i - 1]) && isResolved(statuses[i])) {
                out.push([latlngs[i - 1], latlngs[i]]);
            }
        }
        return out;
    }

    /**
     * Пройденные участки по дороге.
     *
     * way_points из ответа сервиса говорит, какими индексами геометрии
     * представлена каждая исходная точка, — по ним и режем.
     */
    function doneAlongRoad(path, statuses) {
        const out = [];
        for (let i = 1; i < path.wayPoints.length; i++) {
            if (!isResolved(statuses[i - 1]) || !isResolved(statuses[i])) continue;
            const slice = path.geometry.slice(path.wayPoints[i - 1], path.wayPoints[i] + 1);
            if (slice.length > 1) out.push(slice);
        }
        return out;
    }

    /** Пунктир от пользователя к следующей цели. */
    function setLeg(from, to) {
        legLine.setLatLngs(from && to ? [[from.lat, from.lng], [to.lat, to.lng]] : []);
    }

    /**
     * Путь возвращения на маршрут. Принимает готовую геометрию от сервиса,
     * а при её отсутствии — прямую до точки возврата.
     */
    function setLeadIn(geometry) {
        leadInLine.setLatLngs(geometry ?? []);
    }

    /* ------------------------------ пользователь ------------------------------ */

    /**
     * Маркер позиции — L.marker с divIcon, а не circleMarker.
     *
     * divIcon это обычный DOM-элемент в markerPane: он рисуется без участия
     * SVG-рендерера, поэтому не зависит от того, в какой слой попал. Прежний
     * circleMarker с принудительным pane: 'markerPane' требовал, чтобы Leaflet
     * создал отдельный SVG-рендерер в чужом слое, — лишняя зависимость там,
     * где нужна надёжность. Вид (кольцо и пульсация) задаётся из CSS.
     */
    function createUserMarker(latlng) {
        return L.marker(latlng, {
            icon: L.divIcon({
                className: '',
                html: '<div class="user-dot"><span class="user-dot__pulse"></span></div>',
                iconSize: [22, 22],
                iconAnchor: [11, 11],
            }),
            interactive: false,    // маркер позиции ничего не должен перехватывать
            keyboard: false,
            zIndexOffset: 1000,    // поверх маркеров контрольных точек
        }).addTo(map);
    }

    function setUser(fix) {
        if (!fix) return;
        const latlng = [fix.lat, fix.lng];

        if (!userMarker) {
            accuracyCircle = L.circle(latlng, {
                radius: fix.accuracy,
                color: COLORS.next,
                fillColor: COLORS.next,
                fillOpacity: .09,
                weight: 1,
                interactive: false,
            }).addTo(map);

            userMarker = createUserMarker(latlng);
        } else {
            userMarker.setLatLng(latlng);
            accuracyCircle.setLatLng(latlng).setRadius(fix.accuracy);
        }

        if (!hasCenteredOnUser) {
            hasCenteredOnUser = true;
            map.setView(latlng, Math.max(map.getZoom(), 16));
        } else if (follow) {
            map.panTo(latlng, { animate: true, duration: .4 });
        }
    }

    /* ------------------------------ публичный интерфейс ------------------------------ */

    return {
        map,

        renderRoute,
        setLeg,
        setLeadIn,
        setUser,

        setAddMode(on) {
            el.classList.toggle('adding', on);
        },

        setFollow(on) {
            follow = on;
        },

        get follow() {
            return follow;
        },

        get tilesDown() {
            return tilesDown;
        },

        center(latlng, zoom) {
            if (!latlng) return;
            map.setView([latlng.lat, latlng.lng], zoom ?? Math.max(map.getZoom(), 17), { animate: true });
        },

        fitRoute(places) {
            if (places.length === 0) return;
            if (places.length === 1) {
                map.setView([places[0].lat, places[0].lng], 16);
                return;
            }
            map.fitBounds(places.map((p) => [p.lat, p.lng]), { padding: [50, 50], maxZoom: 17 });
        },

        /** Дёргается после смены раскладки: Leaflet должен пересчитать размер контейнера. */
        invalidate() {
            map.invalidateSize();
        },
    };
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
