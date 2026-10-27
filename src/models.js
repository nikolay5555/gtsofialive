/* Vehicle model reference data adapted from Dimitar5555/sofiatraffic-livemap (data/models.js). */
(() => {
const models = {
    tram: [
        {
            id: 'pesa_swing',
            name: "Pesa Swing-122NaSF",
            gauge: 1009,
            inv_number_ranges: [
                [2301, 2399]
            ],
            extras: ['ac', 'low_floor']
        },
        {
            id: 'tatra_t6a2_sf',
            name: "ČKD Tatra T6A2 SF",
            gauge: 1009,
            inv_number_ranges: [
                [2041, 2057]
            ]
        },
        {
            id: 'tatra_t6a2b',
            name: "ČKD Tatra T6A2B",
            gauge: 1009,
            inv_number_ranges: [
                [2033, 2034],
                [3001, 3040]
            ]
        },
        {
            id: 'inekon',
            name: "ЗТС Т8М-700IT (Inekon)",
            gauge: 1009,
            inv_number_ranges: [
                [3401, 3420]
            ],
            extras: ['low_floor']
        },
        {
            id: 'schindler',
            name: "Schindler Waggon AG Be 4-6",
            gauge: 1009,
            inv_number_ranges: [
                [601, 699]
            ],
            extras: ['low_floor']
        },
        {
            id: 't8m_500_f',
            name: "ЗТС T8M-500 F",
            gauge: 1009,
            inv_number_ranges: [
                [501, 599]
            ]
        },
        {
            id: 't8m_900_f',
            name: "ЗТС T8M-900 F",
            gauge: 1009,
            inv_number_ranges: [
                [901, 999]
            ],
            extras: ['low_floor']
        },
        {
            id: 't6m_700_f',
            name: "ЗТС T6M-700 F",
            gauge: 1009,
            inv_number_ranges: [
                [701, 899]
            ]
        },
        {

            id: 'tatra_t6b5b',
            name: "ČKD Tatra T6B5",
            gauge: 1435,
            inv_number_ranges: [
                [4101, 4139]
            ]
        },
        {
            id: 'tatra_t6a5',
            name: "ČKD Tatra T6A5",
            gauge: 1435,
            inv_number_ranges: [
                [4140, 4199]
            ]
        },
        {
            id: 'duewag_gt8',
            name: "Duewag GT8",
            gauge: 1435,
            inv_number_ranges: [
                [4401, 4450]
            ]
        }

    ],
    trolley: [
        {
            id: 'ikarus_facelift',
            name: "Ikarus 280.92F",
            inv_number_ranges: [
                2108,
                2903
            ],
            is_bendy: true
        },
        {
            id: 'ikarus',
            name: "Ikarus 280.92T",
            inv_number_ranges: [
                2123,
                2702,
                2703,
                2913,
                2915
            ],
            is_bendy: true
        },
        {
            id: 'skoda_26tr',
            name: "Škoda 26Tr Solaris III",
            inv_number_ranges: [
                [1601, 1649]
            ],
            extras: ['ac', 'low_floor']
        },
        {
            id: 'skoda_27tr_3',
            name: "Škoda 27Tr Solaris III",
            inv_number_ranges: [
                [1650, 1699],
                [2675, 2699]
            ],
            extras: ['ac', 'low_floor'],
            is_bendy: true
        },
        {
            id: 'skoda_27tr_4',
            name: "Škoda 27Tr Solaris IV",
            inv_number_ranges: [
                [2801, 2899]
            ],
            extras: ['ac', 'low_floor'],
            is_bendy: true
        }
    ],
    bus: [
        {
            id: 'man_lions_city_g',
            name: "MAN Lion's City G",
            fuel: 'CNG',
            inv_number_ranges: [
                [1150, 1199],
                [1601, 1699],
                [2000, 2045],
                [2300, 2399],
                [3100, 3199]
            ],
            extras: ['ac', 'low_floor'],
            is_bendy: true
        },
        {
            id: 'yutong_diesel',
            name: "Yutong ZK6126HGA",
            inv_number_ranges: [
                [1201, 1299],
                [2046, 2099],
                [3600, 3649]
            ],
            extras: ['ac', 'low_floor']
        },
        {
            id: 'yutong_cng',
            name: "Yutong ZK6126HGA",
            fuel: 'CNG',
            inv_number_ranges: [
                [3650, 3699]
            ],
            extras: ['ac', 'low_floor']
        },
        {
            id: 'bmc_procity',
            name: "BMC Procity",
            fuel: 'CNG',
            inv_number_ranges: [
                [1401, 1499],
                [2500, 2599],
                [3400, 3499],
                [7041, 7171],
                [7185, 7193]
            ],
            extra_check: (vehicle) => {
                return vehicle.cgm_id.startsWith('A');
            },
            extras: ['ac', 'low_floor']
        },
        {
            id: 'mb_conecto_g',
            name: "Mercedes O345 Conecto G",
            inv_number_ranges: [
                [1100, 1138],
                [2161, 2172],
                [3301, 3399]
            ],
            is_bendy: true
        },
        {
            id: 'mb_conecto_lf',
            name: "Mercedes Conecto LF",
            inv_number_ranges: [
                [1801, 1899]
            ],
            extras: ['low_floor']
        },
        {
            id: 'karsan_ejest',
            name: "Karsan e-Jest",
            inv_number_ranges: [
                [1010, 1099],
                [2501, 2505]
            ],
            extra_check: (vehicle) => {
                const inv_number = vehicle.inv_number;
                const is_zemlyane = vehicle.cgm_id.startsWith('A') && 1010 <= inv_number && inv_number <= 1099;
                const is_tramkar = vehicle.cgm_id.startsWith('TB') && 2501 <= inv_number && inv_number <= 2505;
                return is_zemlyane || is_tramkar;
            },
            extras: ['ac', 'low_floor']
        },
        {
            id: 'bmc_belde',
            name: "BMC Belde 220-SLF",
            inv_number_ranges: [
                [2720, 2799],
                [3700, 3899]
            ],
            extras: ['low_floor']
        },
        {
            id: 'higer_12m',
            name: "Higer KLQ6125GEV3",
            inv_number_ranges: [
                [1701, 1703],
                [1705],
                [5001, 5099]
            ],
            extras: ['ac', 'low_floor']
        },
        {
            id: 'higer_9m',
            name: "Higer KLQ6832GEV",
            inv_number_ranges: [
                [2811, 2832]
            ]
        },
        {
            id: 'yutong_electric',
            name: "Yutong E12LF",
            inv_number_ranges: [
                [2800, 2810],
                [2833, 2899],
                [3011, 3099]
            ],
            extras: ['ac', 'low_floor']
        },
        {
            id: 'mb_conecto_s',
            name: "Mercedes O345 Conecto",
            inv_number_ranges: [
                [1901, 1999]
            ]
        },
        {
            id: 'man_sg262',
            name: "MAN SG262",
            inv_number_ranges: [
                [2135, 2160]
            ],
            is_bendy: true
        },
        {
            id: 'mb_intouro',
            name: "Mercedes Intouro ME",
            inv_number_ranges: [
                [1301, 1399]
            ],
            extras: ['ac']
        },
        {
            id: 'man_dd',
            name: "MAN Lion's City DD",
            inv_number_ranges: [
                [2602, 2605]
            ],
            extras: ['ac', 'low_floor', 'double_decker']
        },
        {
            id: 'mb_o345g',
            name: "Mercedes O345 G",
            inv_number_ranges: [
                3592
            ],
            is_bendy: true
        },
        {
            id: 'neoplan_dd',
            name: "Neoplan N4426/3 Centroliner",
            inv_number_ranges: [
                2601
            ],
            extras: ['ac', 'low_floor', 'double_decker']
        },
        {
            id: 'man_lions_city_12m',
            name: "MAN Lion's City",
            fuel: 'CNG',
            inv_number_ranges: [
                7173,
                7175
            ],
            extras: ['ac', 'low_floor']
        },
        {
            id: 'mb-conecto-III',
            name: "Mercedes Conecto NG",
            inv_number_ranges: [
                7179,
                7181,
                7183
            ],
            extras: ['ac', 'low_floor']
        },
        {
            id: 'man_lions_city_le',
            name: "MAN Lion's City LE",
            inv_number_ranges: [
                7177
            ],
            extras: ['ac', 'low_floor']
        }
    ]
};

function get_vehicle_model(vehicle) {
    const { type, cgm_id } = vehicle;
    let { inv_number } = vehicle;
    if(typeof inv_number === 'string') {
        inv_number = parseInt(inv_number.split(/[\/+]/)[0]);
    }
    // Some CGM records encode a 4-digit inventory as a 5-digit value with a trailing zero.
    if (Number.isFinite(inv_number) && inv_number > 9999) inv_number = inv_number / 10;
    if (!models[type]) return { name: 'Неизвестен модел' };
    for (const model of models[type]) {
        for (const range of model.inv_number_ranges) {
            if(model.extra_check && !model.extra_check(vehicle)) {
                continue;
            }
            if(typeof range === 'object') {
                const [lb, rb] = range;
                if (lb <= inv_number && inv_number <= rb) {
                    return model;
                }
            }
            else {
                if (range === inv_number) {
                    return model;
                }
            }
        }
    }
    return { name: "Неизвестен модел" };
}

function get_vehicle_model_name(vehicle) {
    const model = get_vehicle_model(vehicle);
    return get_model_name(model);
}

function get_vehicle_type_by_inventory(vehicle) {
    let inv_number = vehicle?.inv_number;
    if (typeof inv_number === 'string') inv_number = parseInt(inv_number.split(/[\/+]/)[0], 10);
    if (!Number.isFinite(inv_number)) return null;
    if (inv_number > 9999) inv_number = inv_number / 10;
    const matches = [];
    for (const type of Object.keys(models)) {
        for (const model of models[type]) {
            if (model.extra_check && !model.extra_check(vehicle)) continue;
            const isMatch = model.inv_number_ranges.some((range) => {
                if (Array.isArray(range)) return range[0] <= inv_number && inv_number <= range[1];
                return range === inv_number;
            });
            if (isMatch) { matches.push(type); break; }
        }
    }
    const uniqueTypes = [...new Set(matches)];
    return uniqueTypes.length === 1 ? uniqueTypes[0] : null;
}

const models_by_type_and_models = {
    tram: models.tram.reduce((obj, item) => (obj[item.id] = item, obj), {}),
    trolley: models.trolley.reduce((obj, item) => (obj[item.id] = item, obj), {}),
    bus: models.bus.reduce((obj, item) => (obj[item.id] = item, obj), {})
};

function get_model_name(model) {
    const name = model.name ?? "Неизвестен модел";
    const fuel = model.fuel ?? '';
    const length = model.length ? `(${model.length} m)` : '';
    return [name, fuel, length].filter(x => x).join(' ');
}


window.GTSOFIA_VEHICLE_MODELS = { models, get_vehicle_model, get_vehicle_model_name, get_model_name, get_vehicle_type_by_inventory };

})();
