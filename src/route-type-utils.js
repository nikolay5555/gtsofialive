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

    return Object.freeze({
        normalizeRouteRef,
        determineRouteType
    });
});
