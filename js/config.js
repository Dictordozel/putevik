/**
 * Географические умолчания Путевика.
 *
 * Приложение рассчитано на прогулки по Калининграду — это не универсальный
 * редактор маршрутов. Поэтому все привязки к местности собраны здесь,
 * а не разбросаны по модулям, которым понадобились первыми.
 */

/** Домашний центр карты, пока нет ни маршрута, ни позиции от GPS. */
export const HOME_CENTER = { lat: 54.7104, lng: 20.4522 };

/** Стартовый зум: весь центр города в кадре. */
export const HOME_ZOOM = 13;

/** Тот же центр в формате, который ждёт Leaflet. */
export const HOME_LATLNG = [HOME_CENTER.lat, HOME_CENTER.lng];

/* ============================== Прокладка по улицам ============================== */

/**
 * Ключ openrouteservice.
 *
 * Лежит в открытом виде намеренно: репозиторий публичный, а ключ бесплатный
 * и ограничен 2000 запросами в сутки. При злоупотреблении отзывается
 * и заменяется на openrouteservice.org за минуту.
 */
export const ORS_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImY0MTg1NTc2NTY3ZDQ1NWY5NzI0YTllM2YzMzYyNjhjIiwiaCI6Im11cm11cjY0In0=';

/** Пеший профиль: дворы, тропинки и переходы, а не проезжая часть. */
export const ORS_URL = 'https://api.openrouteservice.org/v2/directions/foot-walking/geojson';

/** Сервис принимает не больше 50 точек за один запрос. */
export const ORS_MAX_POINTS = 50;

/** Не дёргать сервис чаще, чем нужно. */
export const ROUTE_DEBOUNCE_MS = 800;      // после последней правки точек
export const LEAD_IN_MIN_INTERVAL_MS = 15000;
export const LEAD_IN_MIN_SHIFT_M = 50;     // пересчёт, только если пользователь сместился
