/**
 * Интерфейс: панель прогресса, список точек с редактором, шит маршрутов,
 * строка состояния GPS и тосты.
 *
 * Полная перерисовка списка происходит только при изменении структуры маршрута.
 * Расстояния обновляются каждую секунду и правятся точечно — иначе открытый
 * редактор закрывался бы на каждом фиксе GPS.
 */

import { KINDS, stepLength } from './store.js';
import { formatDistance, formatAge, formatSteps } from './geodesy.js';

const STATUS_TEXT = {
    pending: 'Не пройдена',
    next: '➜ Следующая цель',
    completed: '✓ Пройдено 🎉',
    skipped: '⤳ Пропущена',
};

/**
 * Расстояния наружу выходят в шагах: метры остаются внутри для расчётов.
 * Исключение — радиус точки: он привязан к погрешности GPS, которая в метрах.
 */
const dist = (meters) => formatSteps(meters, stepLength());

const GPS_TEXT = {
    idle: 'Ожидание GPS…',
    requesting: 'Ищем спутники…',
    live: 'GPS активен',
    stale: 'Сигнал потерян',
    timeout: 'Ждём сигнал…',
    denied: 'Нет доступа к геопозиции',
    unavailable: 'GPS недоступен',
    insecure: 'Нужен HTTPS',
};

const TOAST_MS = 3200;

const $ = (id) => document.getElementById(id);

export function createUI(handlers) {
    const el = {
        app: $('app'),
        drawer: $('drawer'),
        handle: $('drawer-handle'),
        peekPct: $('peek-pct'),
        peekNext: $('peek-next'),

        routePicker: $('route-picker'),
        routePickerName: $('route-picker-name'),
        pickPrompt: $('pick-prompt'),
        btnPick: $('btn-pick'),
        routeActive: $('route-active'),
        routeSearch: $('route-search'),
        routeEmpty: $('route-empty'),

        progressBar: $('progress-bar'),
        progressFill: $('progress-fill'),
        statPct: $('stat-pct'),
        statCount: $('stat-count'),
        statTotal: $('stat-total'),
        statLeft: $('stat-left'),

        targetCard: $('target-card'),
        targetEmpty: $('target-empty'),
        targetBody: $('target-body'),
        targetName: $('target-name'),
        targetDist: $('target-dist'),
        targetNote: $('target-note'),

        cpList: $('cp-list'),

        gpsChip: $('gps-chip'),
        gpsLabel: $('gps-label'),
        gpsAccuracy: $('gps-accuracy'),
        offlineChip: $('offline-chip'),
        btnUpdate: $('btn-update'),

        addHint: $('add-hint'),
        btnAddCancel: $('btn-add-cancel'),
        fabAdd: $('fab-add'),
        fabLocate: $('fab-locate'),

        btnResetProgress: $('btn-reset-progress'),
        btnClearRoute: $('btn-clear-route'),

        devPanel: $('dev-panel'),
        heightInput: $('height-input'),
        stepLen: $('step-len'),
        stepSource: $('step-source'),
        calibNote: $('calib-note'),
        btnCalib: $('btn-calib'),
        btnCalibReset: $('btn-calib-reset'),
        calibFinish: $('calib-finish'),
        calibSteps: $('calib-steps'),
        btnCalibSave: $('btn-calib-save'),
        devGps: $('dev-gps'),
        devCoords: $('dev-coords'),
        devAge: $('dev-age'),

        sheet: $('routes-sheet'),
        routeList: $('route-list'),
        btnRoutesClose: $('btn-routes-close'),
        btnNewRoute: $('btn-new-route'),
        btnExport: $('btn-export'),
        btnImport: $('btn-import'),
        importFile: $('import-file'),

        toasts: $('toasts'),
        tplCp: $('tpl-cp'),
        tplRoute: $('tpl-route'),
    };

    let expandedId = null;   // какой редактор точки раскрыт
    let listSignature = '';  // структура списка: пока не менялась — не перерисовываем
    let devHinted = false;   // раздел отладки уже раскрывали из-за проблем с GPS
    const rows = new Map();  // placeId → узлы пункта списка

    /* ============================== Drawer ============================== */

    const DRAWER_ORDER = ['peek', 'half', 'full'];
    const DRAG_THRESHOLD = 24;   // px, дальше жест считается свайпом, а не тапом

    function setDrawer(stateName) {
        el.app.dataset.drawer = stateName;
        el.drawer.dataset.state = stateName;
        el.handle.setAttribute('aria-expanded', String(stateName !== 'peek'));
    }

    function currentDrawer() {
        return el.app.dataset.drawer || 'peek';
    }

    /** Тап по хваталке: сворачивает раскрытую панель и раскрывает свёрнутую. */
    function toggleDrawer() {
        setDrawer(currentDrawer() === 'peek' ? 'half' : 'peek');
    }

    /** Свайп: шаг по состояниям вверх или вниз, без закольцовывания. */
    function shiftDrawer(step) {
        const i = DRAWER_ORDER.indexOf(currentDrawer());
        const next = Math.min(DRAWER_ORDER.length - 1, Math.max(0, i + step));
        setDrawer(DRAWER_ORDER[next]);
    }

    let dragStartY = null;
    let dragMoved = false;

    el.handle.addEventListener('pointerdown', (event) => {
        dragStartY = event.clientY;
        dragMoved = false;
    });

    el.handle.addEventListener('pointermove', (event) => {
        if (dragStartY === null) return;
        if (Math.abs(event.clientY - dragStartY) > DRAG_THRESHOLD) dragMoved = true;
    });

    el.handle.addEventListener('pointerup', (event) => {
        if (dragStartY === null) return;
        const dy = event.clientY - dragStartY;
        dragStartY = null;
        if (dragMoved) shiftDrawer(dy < 0 ? 1 : -1);
        else toggleDrawer();
    });

    el.handle.addEventListener('pointercancel', () => { dragStartY = null; });

    // Клавиатура: Enter и Space дают click с detail === 0, мышиный тап — нет,
    // поэтому обработчики жеста и клавиатуры не конфликтуют.
    el.handle.addEventListener('click', (event) => {
        if (event.detail === 0) toggleDrawer();
    });

    /* ============================== Кнопки ============================== */

    el.fabAdd.addEventListener('click', () => handlers.onToggleAdd?.());
    el.btnAddCancel.addEventListener('click', () => handlers.onToggleAdd?.(false));
    el.fabLocate.addEventListener('click', () => handlers.onLocate?.());

    el.routePicker.addEventListener('click', () => handlers.onOpenRoutes?.());
    el.btnPick.addEventListener('click', () => handlers.onOpenRoutes?.());
    el.routeSearch.addEventListener('input', () => handlers.onSearchRoutes?.(el.routeSearch.value));

    el.btnResetProgress.addEventListener('click', () => handlers.onResetProgress?.());
    el.btnClearRoute.addEventListener('click', () => handlers.onClearRoute?.());

    el.btnRoutesClose.addEventListener('click', () => el.sheet.close());
    el.btnNewRoute.addEventListener('click', () => handlers.onNewRoute?.());
    el.btnExport.addEventListener('click', () => handlers.onExport?.());
    el.btnImport.addEventListener('click', () => el.importFile.click());

    el.importFile.addEventListener('change', () => {
        const file = el.importFile.files?.[0];
        if (file) handlers.onImport?.(file);
        el.importFile.value = '';   // иначе повторный выбор того же файла не сработает
    });

    el.btnUpdate.addEventListener('click', () => handlers.onUpdateApp?.());

    el.heightInput.addEventListener('change', () => handlers.onHeightChange?.(el.heightInput.value));
    el.btnCalib.addEventListener('click', () => handlers.onCalibStart?.());
    el.btnCalibReset.addEventListener('click', () => handlers.onCalibReset?.());
    el.btnCalibSave.addEventListener('click', () => handlers.onCalibSave?.(el.calibSteps.value));

    /* ============================== Список точек ============================== */

    function signatureOf(places, statuses) {
        return places.map((p, i) => `${p.id}:${statuses[i]}:${p.name}:${p.kind}:${p.radius}`).join('|');
    }

    function buildRow(place, index, status) {
        const node = el.tplCp.content.firstElementChild.cloneNode(true);
        node.dataset.id = place.id;
        node.classList.add(`cp--${status}`);

        const row = node.querySelector('.cp__row');
        const editor = node.querySelector('.cp__editor');
        const nameEl = node.querySelector('.cp__name');
        const statusEl = node.querySelector('.cp__status');
        const distEl = node.querySelector('.cp__dist');

        node.querySelector('.cp__index').textContent = status === 'completed' ? '✓' : String(index + 1);
        nameEl.textContent = place.name || 'Без названия';

        statusEl.className = `cp__status badge badge--${status}`;
        statusEl.textContent = STATUS_TEXT[status];

        // Раскрытие редактора
        row.addEventListener('click', () => {
            const open = editor.hidden;
            expandedId = open ? place.id : null;
            editor.hidden = !open;
            row.setAttribute('aria-expanded', String(open));
        });

        // Поля редактора
        const fields = {
            name: editor.querySelector('[data-edit="name"]'),
            note: editor.querySelector('[data-edit="note"]'),
            kind: editor.querySelector('[data-edit="kind"]'),
            radius: editor.querySelector('[data-edit="radius"]'),
        };

        fields.name.value = place.name;
        fields.note.value = place.note;
        fields.kind.value = place.kind;
        fields.radius.value = place.radius;

        fields.name.addEventListener('change', () => handlers.onEditPlace?.(place.id, { name: fields.name.value }));
        fields.note.addEventListener('change', () => handlers.onEditPlace?.(place.id, { note: fields.note.value }));
        fields.kind.addEventListener('change', () => handlers.onEditPlace?.(place.id, { kind: fields.kind.value }));
        fields.radius.addEventListener('change', () => handlers.onEditPlace?.(place.id, { radius: fields.radius.value }));

        const btnComplete = editor.querySelector('[data-act="complete"]');
        const btnSkip = editor.querySelector('[data-act="skip"]');

        btnComplete.textContent = status === 'completed' ? 'Снять отметку' : 'Отметить пройденной';
        btnSkip.textContent = status === 'skipped' ? 'Вернуть в маршрут' : 'Пропустить';

        btnComplete.addEventListener('click', () =>
            handlers.onSetPlaceState?.(place.id, status === 'completed' ? 'pending' : 'completed'));
        btnSkip.addEventListener('click', () =>
            handlers.onSetPlaceState?.(place.id, status === 'skipped' ? 'pending' : 'skipped'));

        editor.querySelector('[data-act="up"]').addEventListener('click', () => handlers.onMovePlace?.(place.id, -1));
        editor.querySelector('[data-act="down"]').addEventListener('click', () => handlers.onMovePlace?.(place.id, 1));
        editor.querySelector('[data-act="center"]').addEventListener('click', () => handlers.onCenterPlace?.(place.id));
        editor.querySelector('[data-act="remove"]').addEventListener('click', () => handlers.onRemovePlace?.(place.id));

        if (expandedId === place.id) {
            editor.hidden = false;
            row.setAttribute('aria-expanded', 'true');
        }

        rows.set(place.id, { node, distEl, nameEl });
        return node;
    }

    function renderList(places, statuses) {
        const signature = signatureOf(places, statuses);
        if (signature === listSignature) return false;
        listSignature = signature;

        rows.clear();
        el.cpList.replaceChildren();

        if (places.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'empty-note';
            empty.textContent = 'Точек пока нет. Нажмите + и тапните по карте.';
            el.cpList.append(empty);
            return true;
        }

        const fragment = document.createDocumentFragment();
        places.forEach((place, i) => fragment.append(buildRow(place, i, statuses[i])));
        el.cpList.append(fragment);
        return true;
    }

    /** Точечное обновление расстояний — вызывается часто, DOM не пересобирает. */
    function updateDistances(places, distances) {
        places.forEach((place, i) => {
            const row = rows.get(place.id);
            if (!row) return;
            const meters = distances[i];
            row.distEl.textContent = Number.isFinite(meters) ? dist(meters) : '';
        });
    }

    /* ============================== Главный рендер ============================== */

    function render(view) {
        const { places, statuses, stats, target, distances, addMode, follow } = view;

        // Маршрут не выбран — законное состояние: приложение ничего не
        // активирует само, поэтому показываем приглашение вместо прогресса.
        const hasRoute = view.routeName !== null;
        el.routePickerName.textContent = hasRoute ? (view.routeName || 'Без названия') : 'Не выбран';
        el.pickPrompt.hidden = hasRoute;
        el.routeActive.hidden = !hasRoute;

        el.fabAdd.setAttribute('aria-pressed', String(addMode));
        el.fabAdd.disabled = !hasRoute;
        el.addHint.hidden = !addMode;
        el.fabLocate.setAttribute('aria-pressed', String(follow));

        if (!hasRoute) {
            el.peekPct.textContent = '—';
            el.peekNext.textContent = 'Маршрут не выбран';
            return;
        }

        el.progressFill.style.width = `${stats.percent}%`;
        el.progressBar.setAttribute('aria-valuenow', String(stats.percent));
        el.statPct.textContent = `${stats.percent}%`;
        el.statCount.textContent = stats.skippedCount
            ? `${stats.completedCount} из ${stats.count} · ${stats.skippedCount} проп.`
            : `${stats.completedCount} из ${stats.count}`;
        el.statTotal.textContent = stats.count > 1 ? dist(stats.total) : '—';
        el.statLeft.textContent = stats.count > 1 ? dist(stats.left) : '—';

        el.peekPct.textContent = `${stats.percent}%`;

        // Карточка следующей цели
        const finished = stats.finished;
        el.targetCard.classList.toggle('target--done', finished);

        if (places.length === 0) {
            el.targetEmpty.hidden = false;
            el.targetBody.hidden = true;
            el.peekNext.textContent = 'Маршрут пуст';
        } else if (finished) {
            el.targetEmpty.hidden = true;
            el.targetBody.hidden = false;
            el.targetName.textContent = 'Маршрут пройден полностью';
            el.targetDist.textContent = '🎉';
            el.targetNote.textContent = `${stats.count} точек · ${dist(stats.total)}`;
            el.peekNext.textContent = 'Маршрут пройден 🎉';
        } else {
            el.targetEmpty.hidden = true;
            el.targetBody.hidden = false;
            const name = target?.place?.name || 'Следующая точка';
            const shown = Number.isFinite(target?.distance) ? dist(target.distance) : 'ждём GPS';
            el.targetName.textContent = name;
            el.targetDist.textContent = shown;
            el.targetNote.textContent = target?.place?.note ||
                `${KINDS[target?.place?.kind]?.label ?? ''} · радиус ${target?.place?.radius ?? '—'} м`;
            el.peekNext.textContent = `${name} — ${shown}`;
        }

        renderList(places, statuses);
        updateDistances(places, distances);
    }

    /* ============================== Состояние GPS ============================== */

    function setGps({ status, detail, fix, lowAccuracy }) {
        el.gpsChip.dataset.status = status;
        el.gpsLabel.textContent = GPS_TEXT[status] ?? status;
        el.gpsChip.classList.toggle('low-accuracy', Boolean(lowAccuracy));

        el.gpsAccuracy.textContent = fix && Number.isFinite(fix.accuracy)
            ? `±${Math.round(fix.accuracy)} м`
            : '';

        el.gpsChip.title = detail || '';

        el.devGps.textContent = detail ? `${status} — ${detail}` : status;
        el.devCoords.textContent = fix ? `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}` : '—';

        // При проблемах с GPS один раз сами раскрываем раздел с подробностями:
        // координаты и возраст фикса показывают, что именно происходит.
        if (!devHinted && ['denied', 'insecure', 'unavailable'].includes(status)) {
            devHinted = true;
            el.devPanel.open = true;
            setDrawer('half');
        }
    }

    /** Раздел «Шаг и рост»: длина шага, её источник и поле роста. */
    function setSteps({ heightCm, stepMeters, calibrated }) {
        if (document.activeElement !== el.heightInput) el.heightInput.value = heightCm;
        el.stepLen.textContent = `${stepMeters.toFixed(2).replace('.', ',')} м`;
        el.stepSource.textContent = calibrated ? 'калибровка' : 'оценка по росту';
        el.btnCalibReset.hidden = !calibrated;
    }

    /**
     * Состояние калибровки. Пока идёт — показываем накопленное расстояние,
     * по завершении просим число шагов.
     */
    function setCalibration({ active, meters, awaitingSteps }) {
        el.btnCalib.textContent = active ? 'Завершить и ввести шаги' : 'Начать калибровку';
        el.calibFinish.hidden = !awaitingSteps;

        if (active) {
            el.calibNote.textContent = `Идёт калибровка: пройдено ${formatDistance(meters)}. Считайте шаги.`;
        } else if (awaitingSteps) {
            el.calibNote.textContent = `Пройдено ${formatDistance(meters)}. Сколько шагов вы сделали?`;
        } else {
            el.calibNote.textContent = 'Оценка по росту приблизительная. Пройдите отрезок, посчитав свои шаги, — и приложение вычислит вашу настоящую длину шага.';
            el.calibSteps.value = '';
        }
    }

    function setFixAge(ms) {
        el.devAge.textContent = Number.isFinite(ms) ? `${formatAge(ms)} назад` : '—';
    }

    function setOffline(isOffline, tilesDown) {
        el.offlineChip.hidden = !(isOffline || tilesDown);
        el.offlineChip.lastChild.textContent = isOffline
            ? ' Нет сети — карта неполная'
            : ' Тайлы не загружаются';
    }

    function setUpdateAvailable(on) {
        el.btnUpdate.hidden = !on;
    }

    /* ============================== Шит маршрутов ============================== */

    function renderRoutes(routes, activeId, statsOf) {
        el.routeList.replaceChildren();

        const searching = el.routeSearch.value.trim().length > 0;
        el.routeEmpty.hidden = routes.length > 0;
        el.routeEmpty.textContent = searching
            ? 'Ничего не нашлось. Поиск идёт по названию маршрута и по названиям точек внутри него.'
            : 'Сохранённых маршрутов пока нет. Создайте первый.';

        for (const route of routes) {
            const node = el.tplRoute.content.firstElementChild.cloneNode(true);
            const stats = statsOf(route.id);

            node.dataset.id = route.id;
            node.classList.toggle('route-item--active', route.id === activeId);
            node.querySelector('.route-item__name').textContent = route.name || 'Без названия';
            node.querySelector('.route-item__meta').textContent =
                `${stats.count} точек · ${dist(stats.total)} · пройдено ${stats.percent}%` +
                (route.id === activeId ? ' · активный' : '');

            node.querySelector('.route-item__open')
                .addEventListener('click', () => handlers.onSelectRoute?.(route.id));
            node.querySelector('[data-act="rename"]')
                .addEventListener('click', () => handlers.onRenameRoute?.(route.id, route.name));
            node.querySelector('[data-act="duplicate"]')
                .addEventListener('click', () => handlers.onDuplicateRoute?.(route.id));
            node.querySelector('[data-act="delete"]')
                .addEventListener('click', () => handlers.onDeleteRoute?.(route.id, route.name));

            el.routeList.append(node);
        }
    }

    function openRoutesSheet() {
        if (!el.sheet.open) el.sheet.showModal();
    }

    /** Сбрасывает поисковый запрос — вызывается при закрытии шита. */
    function clearRouteSearch() {
        el.routeSearch.value = '';
    }

    function closeRoutesSheet() {
        if (el.sheet.open) el.sheet.close();
    }

    /* ============================== Тосты ============================== */

    function toast(message, kind = 'info') {
        const node = document.createElement('div');
        node.className = `toast toast--${kind}`;
        node.textContent = message;
        el.toasts.append(node);

        setTimeout(() => {
            node.classList.add('toast--leaving');
            node.addEventListener('animationend', () => node.remove(), { once: true });
            setTimeout(() => node.remove(), 400);   // страховка, если анимации отключены
        }, TOAST_MS);
    }

    /* ============================== Фатальная ошибка ============================== */

    /** Большой экран: приложение не запускаем, показываем только адрес. */
    function showDesktopStub() {
        $('desktop-stub').hidden = false;
        el.app.hidden = true;
    }

    function showBootError(title, text) {
        $('boot-error-title').textContent = title;
        $('boot-error-text').textContent = text;
        $('boot-error').hidden = false;
    }

    return {
        render,
        setGps,
        setFixAge,
        setOffline,
        setSteps,
        setCalibration,
        setUpdateAvailable,
        renderRoutes,
        openRoutesSheet,
        closeRoutesSheet,
        clearRouteSearch,
        toast,
        showBootError,
        showDesktopStub,
        setDrawer,
        /** Сбрасывает кэш структуры списка: следующий render() перерисует его целиком. */
        invalidateList() {
            listSignature = '';
        },
    };
}
