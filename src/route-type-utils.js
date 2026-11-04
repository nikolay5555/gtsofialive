(function exposeRouteTypeUtils(root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.GTSOFIA_ROUTE_TYPE_UTILS = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRouteTypeUtils() {
    'use strict';

    const TYPE_BY_GTFS_CODE = Object.freeze({
        '0': 'tram',
        '1': 'metro',
        '3': 'bus',
        '11': 'trolley'
    });

    function normalizeRouteRef(value) {
        let ref = String(value ?? '').trim().toUpperCase();
        if (!ref) return '';

        const number = ref.replace(/[a-zа-я]/gi, '');

        if (ref.startsWith('E') || ref.startsWith('Е')) {
            ref = number;
        } else if (ref.startsWith('N')) {
            ref = `N${number}`;
        } else if (ref.startsWith('Y')) {
            ref = `У${number}`;
        } else if (ref.endsWith('ТБ') || ref.endsWith('TB')) {
            ref = `${number}ТБ`;
        } else if (
            ref.endsWith('ТМ')
            || ref.endsWith('TM')
            || ref.endsWith('Т')
            || ref.endsWith('T')
        ) {
            ref = `${number}ТМ`;
        }

        return ref;
    }

    function determineRouteType(routeRef, routeTypeCode) {
        const normalizedRef = normalizeRouteRef(routeRef);
        let type = TYPE_BY_GTFS_CODE[String(routeTypeCode ?? '')] || 'other';

        if (
            normalizedRef.endsWith('ТБ')
            || normalizedRef.endsWith('ТМ')
            || ((normalizedRef.startsWith('М') || normalizedRef.startsWith('M')) && type === 'bus')
        ) {
            type = 'bus';
        }

        // Match GTSofia's route-metadata.js rule: GTFS trolley routes numbered
        // 50+ are replacement bus services in the Sofia feed.
        const sortRef = Number.parseInt(normalizedRef.replace(/[a-zа-я]/gi, ''), 10);
        if (Number.isFinite(sortRef) && sortRef >= 50 && type === 'trolley') {
            type = 'bus';
        }

        return type;
    }

    function normalizeColor(value) {
        let color = String(value ?? '').trim();
        if (!color) return '';
        if (!color.startsWith('#')) color = `#${color}`;
        return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color.toUpperCase() : '';
    }

    function determineRouteColor(routeRef, routeType, sourceColor, overrideColor, metroColor) {
        const type = String(routeType ?? 'other').trim().toLowerCase();
        const palette = Object.freeze({
            bus: '#BE1E2D',
            tram: '#F7941D',
            trolley: '#27AAE1',
            metro: '#1C75BC',
            other: '#111827'
        });

        // Match GTSofia's route-metadata.js: an explicit configured override
        // wins; otherwise only metro and night routes use GTFS route_color.
        const configuredColor = normalizeColor(overrideColor);
        if (configuredColor) return configuredColor;

        const normalizedRef = normalizeRouteRef(routeRef);
        const feedColor = normalizeColor(sourceColor);
        if (normalizedRef.startsWith('N')) return feedColor || '#000000';

        if (type === 'metro') {
            return normalizeColor(metroColor) || feedColor || palette.metro;
        }

        // In particular, do not carry the original blue GTFS trolley color
        // over to a replacement bus after determineRouteType() normalizes it.
        return palette[type] || palette.other;
    }

    return Object.freeze({
        normalizeRouteRef,
        determineRouteType,
        determineRouteColor
    });
});
