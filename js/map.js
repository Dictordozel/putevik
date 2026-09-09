/**
 * Всё, что касается Leaflet: слои, маркеры, линии маршрута, деградация тайлов.
 *
 * Ключевая идея: тайлы и векторные слои независимы. Когда сеть пропадает,
 * подложка гаснет, но точки, круги радиусов и линии маршрута продолжают
 * рисоваться — приложение остаётся рабочим, а не превращается в белое пятно.
 */

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const TILE_ERROR_LIMIT = 6;       // столько ошибок подряд — считаем подложку недоступной
const TILE_ERROR_WINDOW_MS = 8000;

const COLORS = {
    locked: '#94a3b8',
    next: '#1b6ef3',
    completed: '#16a34a',
};

export function createMapView({ el, onMapClick, onCheckpointMoved, onTilesStateChange }) {
    const map = L.map(el, {
        zoomControl: false,
        attributionControl: true,
    }).setView([55.7522, 37.6156], 12);

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

    const legLine = L.polyline([], {
        color: COLORS.next, weight: 3, opacity: .9, dashArray: '2 8', lineCap: 'round',
    }).addTo(map);

    const remainingLine = L.polyline([], {
        color: COLORS.locked, weight: 4, opacity: .85, dashArray: '9 9',
    }).addTo(map);

    const doneLine = L.polyline([], {
        color: COLORS.completed, weight: 5, opacity: .9,
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

    /* ------------------------------ отрисовка маршрута ------------------------------ */

    function markerIcon(index, status) {
        // На карте важен порядок прохождения, поэтому в маркере номер,
        // а тип места показывает список в панели.
        const glyph = status === 'completed' ? '✓' : index + 1;
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
    function renderRoute(places, statuses) {
        const signature = places
            .map((p, i) => `${p.id}:${p.lat.toFixed(6)}:${p.lng.toFixed(6)}:${p.radius}:${p.name}:${p.note}:${statuses[i]}`)
            .join('|');

        if (signature === routeSignature) return;
        routeSignature = signature;

        cpLayer.clearLayers();

        places.forEach((place, i) => {
            const status = statuses[i] ?? 'locked';
            const latlng = [place.lat, place.lng];

            L.circle(latlng, {
                radius: place.radius,
                color: COLORS[status],
                fillColor: COLORS[status],
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

        // Линию делим на пройденную и оставшуюся часть: участок считается
        // пройденным, только если пройдены оба его конца.
        const doneSegments = [];
        const restSegments = [];

        for (let i = 1; i < places.length; i++) {
            const pair = [[places[i - 1].lat, places[i - 1].lng], [places[i].lat, places[i].lng]];
            const bothDone = statuses[i - 1] === 'completed' && statuses[i] === 'completed';
            (bothDone ? doneSegments : restSegments).push(pair);
        }

        doneLine.setLatLngs(doneSegments);
        remainingLine.setLatLngs(restSegments);
    }

    /** Пунктир от пользователя к следующей цели. */
    function setLeg(from, to) {
        legLine.setLatLngs(from && to ? [[from.lat, from.lng], [to.lat, to.lng]] : []);
    }

    /* ------------------------------ пользователь ------------------------------ */

    let onUserDragged = null;
    let userDragging = false;

    /**
     * Маркер позиции — L.marker с divIcon, а не circleMarker.
     *
     * divIcon это обычный DOM-элемент в markerPane: он рисуется без участия
     * SVG-рендерера, поэтому не зависит от того, в какой слой попал. Прежний
     * circleMarker с принудительным pane: 'markerPane' требовал, чтобы Leaflet
     * создал отдельный SVG-рендерер в чужом слое, — лишняя зависимость там,
     * где нужна надёжность. Плюс перетаскивание теперь даёт сам Leaflet,
     * а вид (кольцо и пульсация) задаётся из CSS.
     */
    function createUserMarker(latlng) {
        const marker = L.marker(latlng, {
            icon: L.divIcon({
                className: '',
                html: '<div class="user-dot"><span class="user-dot__pulse"></span></div>',
                iconSize: [22, 22],
                iconAnchor: [11, 11],
            }),
            draggable: false,       // включается только в режиме симуляции
            autoPan: false,
            keyboard: false,
            zIndexOffset: 1000,    // поверх маркеров контрольных точек
            title: 'Ваша позиция',
        }).addTo(map);

        marker.on('dragstart', () => { userDragging = true; });
        marker.on('dragend', () => { userDragging = false; });
        marker.on('drag dragend', (event) => {
            const { lat, lng } = event.target.getLatLng();
            onUserDragged?.({ lat, lng });
        });

        return marker;
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
            // Во время перетаскивания позицию задаёт палец, а не входящий фикс,
            // иначе маркер дёргается под курсором.
            if (!userDragging) userMarker.setLatLng(latlng);
            accuracyCircle.setLatLng(latlng).setRadius(fix.accuracy);
        }

        setUserDraggable(fix.simulated);

        if (!hasCenteredOnUser) {
            hasCenteredOnUser = true;
            map.setView(latlng, Math.max(map.getZoom(), 16));
        } else if (follow && !userDragging) {
            map.panTo(latlng, { animate: true, duration: .4 });
        }
    }

    /** В симуляции маркер тащится мышью или пальцем — это и есть перемещение. */
    function setUserDraggable(on) {
        if (!userMarker?.dragging) return;
        if (on) userMarker.dragging.enable();
        else userMarker.dragging.disable();
        userMarker.getElement()?.classList.toggle('user-draggable', on);
    }

    /* ------------------------------ публичный интерфейс ------------------------------ */

    return {
        map,

        renderRoute,
        setLeg,
        setUser,

        setUserDragHandler(fn) {
            onUserDragged = fn;
        },

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
