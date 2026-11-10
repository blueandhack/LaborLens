// Builds the static geography and occupation reference data used by the map.
//
//   node scripts/build-geo-data.mjs <source directory>
//
// Source files (public data; download into one directory, never committed):
//   zcta_county.txt        https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt
//   ct_cousub_zcta.txt     https://www2.census.gov/geo/docs/maps-data/data/rel2022/acs22_cousub22_zcta520_st09.txt
//                          (Connecticut replaced counties with planning regions in 2022.)
//   list1_2023.xlsx        https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx
//   2023_Gaz_cbsa_national.txt  (unzipped) https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_cbsa_national.zip
//   co_est.csv             https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/counties/totals/co-est2023-alldata.csv
//   onet_2010_2019.csv     https://www.onetcenter.org/taxonomy/2019/walk/2010_to_2019_Crosswalk.csv?fmt=csv
//   onet_2009_2010.csv     https://www.onetcenter.org/taxonomy/2010/walk/2009_to_2010_Crosswalk.csv?fmt=csv
//   2023_Gaz_zcta_national.txt  (unzipped) https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip
//   county/cb_2023_us_county_5m.{shp,dbf}  (unzipped into county/) https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_5m.zip
//
// Outputs backend/data/geo/*.json, frontend/src/data/usStates.json and one
// county-shape file per state in frontend/src/data/counties/.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoAlbersUsa, geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import { topology } from 'topojson-server';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
const shapefile = require('shapefile');
const here = path.dirname(fileURLToPath(import.meta.url));
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/build-geo-data.mjs <source directory>');
const read = name => readFile(path.join(source, name), 'utf8').then(text => text.replace(/^﻿/, ''));

// FIPS, postal code and name for states, DC and territories.
const STATES = [['01', 'AL', 'Alabama'], ['02', 'AK', 'Alaska'], ['04', 'AZ', 'Arizona'], ['05', 'AR', 'Arkansas'], ['06', 'CA', 'California'],
    ['08', 'CO', 'Colorado'], ['09', 'CT', 'Connecticut'], ['10', 'DE', 'Delaware'], ['11', 'DC', 'District of Columbia'], ['12', 'FL', 'Florida'],
    ['13', 'GA', 'Georgia'], ['15', 'HI', 'Hawaii'], ['16', 'ID', 'Idaho'], ['17', 'IL', 'Illinois'], ['18', 'IN', 'Indiana'], ['19', 'IA', 'Iowa'],
    ['20', 'KS', 'Kansas'], ['21', 'KY', 'Kentucky'], ['22', 'LA', 'Louisiana'], ['23', 'ME', 'Maine'], ['24', 'MD', 'Maryland'],
    ['25', 'MA', 'Massachusetts'], ['26', 'MI', 'Michigan'], ['27', 'MN', 'Minnesota'], ['28', 'MS', 'Mississippi'], ['29', 'MO', 'Missouri'],
    ['30', 'MT', 'Montana'], ['31', 'NE', 'Nebraska'], ['32', 'NV', 'Nevada'], ['33', 'NH', 'New Hampshire'], ['34', 'NJ', 'New Jersey'],
    ['35', 'NM', 'New Mexico'], ['36', 'NY', 'New York'], ['37', 'NC', 'North Carolina'], ['38', 'ND', 'North Dakota'], ['39', 'OH', 'Ohio'],
    ['40', 'OK', 'Oklahoma'], ['41', 'OR', 'Oregon'], ['42', 'PA', 'Pennsylvania'], ['44', 'RI', 'Rhode Island'], ['45', 'SC', 'South Carolina'],
    ['46', 'SD', 'South Dakota'], ['47', 'TN', 'Tennessee'], ['48', 'TX', 'Texas'], ['49', 'UT', 'Utah'], ['50', 'VT', 'Vermont'],
    ['51', 'VA', 'Virginia'], ['53', 'WA', 'Washington'], ['54', 'WV', 'West Virginia'], ['55', 'WI', 'Wisconsin'], ['56', 'WY', 'Wyoming'],
    ['60', 'AS', 'American Samoa'], ['66', 'GU', 'Guam'], ['69', 'MP', 'Northern Mariana Islands'], ['72', 'PR', 'Puerto Rico'], ['78', 'VI', 'U.S. Virgin Islands']];
const byFips = new Map(STATES.map(([fips, code, name]) => [fips, { fips, code, name }]));
const byName = new Map(STATES.map(([fips, code, name]) => [name.toLowerCase(), code]));
// us-atlas states-albers-10m is pre-projected with exactly this projection.
const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);
const round = value => Math.round(value * 10) / 10;

function table(text, separator) {
    const [header, ...lines] = text.split(/\r?\n/).filter(Boolean);
    const names = header.split(separator).map(name => name.trim());
    return lines.map(line => Object.fromEntries(line.split(separator).map((value, index) => [names[index], value.trim()])));
}
function csv(text) {
    const rows = [];
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
        const cells = []; let cell = '', quoted = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (quoted) { if (char === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') quoted = false; else cell += char; }
            else if (char === '"') quoted = true; else if (char === ',') { cells.push(cell); cell = ''; } else cell += char;
        }
        cells.push(cell); rows.push(cells);
    }
    const [header, ...body] = rows;
    return body.map(cells => Object.fromEntries(header.map((name, index) => [name, cells[index]])));
}

// --- Metropolitan and micropolitan statistical areas (CBSAs) ---
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(path.join(source, 'list1_2023.xlsx'));
const sheet = workbook.worksheets[0];
const countyMetro = new Map(), metros = new Map();
sheet.eachRow((row, number) => {
    if (number < 4) return;
    const [, code, , , title, kind, , , , , stateFips, countyFips] = row.values;
    if (!/^\d{5}$/.test(String(code)) || !stateFips || !countyFips) return;
    countyMetro.set(String(stateFips).padStart(2, '0') + String(countyFips).padStart(3, '0'), String(code));
    if (!metros.has(String(code))) {
        const states = String(title).split(', ').at(-1).split('-');
        metros.set(String(code), { code: String(code), name: String(title), type: /Metropolitan/.test(kind) ? 'metro' : 'micro', state: states[0], states, population: 0 });
    }
});
for (const row of table(await read('2023_Gaz_cbsa_national.txt'), '\t')) {
    const metro = metros.get(row.GEOID);
    if (!metro) continue;
    const point = projection([Number(row.INTPTLONG), Number(row.INTPTLAT)]);
    Object.assign(metro, { lat: Number(row.INTPTLAT), lon: Number(row.INTPTLONG), x: point ? round(point[0]) : null, y: point ? round(point[1]) : null });
}

// --- Population (Vintage 2023 estimates; Puerto Rico is published separately and is omitted) ---
const statePopulation = new Map(), countyPopulation = new Map();
for (const row of csv((await readFile(path.join(source, 'co_est.csv'), 'latin1')))) {
    const population = Number(row.POPESTIMATE2023);
    if (row.SUMLEV === '040') statePopulation.set(row.STATE, population);
    if (row.SUMLEV === '050') {
        countyPopulation.set(row.STATE + row.COUNTY, population);
        const metro = metros.get(countyMetro.get(row.STATE + row.COUNTY));
        if (metro) metro.population += population;
    }
}
for (const metro of metros.values()) if (!metro.population) metro.population = null;

// --- ZIP Code Tabulation Areas to counties, then CBSAs ---
// Each ZCTA belongs to the county holding most of its land. Connecticut ZCTAs
// use the 2022 planning-region relationship, matching the 2023 delineations.
const parts = new Map();
const addPart = (zcta, county, land, water) => {
    if (!/^\d{5}$/.test(zcta) || !/^\d{5}$/.test(county)) return;
    const counties = parts.get(zcta) || new Map();
    counties.set(county, (counties.get(county) || 0) + land * 1e6 + water);
    parts.set(zcta, counties);
};
for (const row of table(await read('zcta_county.txt'), '|')) if (!row.GEOID_COUNTY_20.startsWith('09')) addPart(row.GEOID_ZCTA5_20, row.GEOID_COUNTY_20, Number(row.AREALAND_PART), Number(row.AREAWATER_PART));
for (const row of table(await read('ct_cousub_zcta.txt'), '|')) addPart(row.GEOID_ZCTA5_20, row.GEOID_COUSUB_22.slice(0, 5), Number(row.AREALAND_PART), Number(row.AREAWATER_PART));
const zips = {}, zip3 = new Map(), zipCounty = new Map();
for (const [zcta, counties] of [...parts].sort()) {
    const county = [...counties].sort((a, b) => b[1] - a[1])[0][0];
    zipCounty.set(zcta, county);
    const metro = countyMetro.get(county) || null;
    if (metro) zips[zcta] = metro;
    const prefix = zcta.slice(0, 3), tally = zip3.get(prefix) || new Map();
    tally.set(metro, (tally.get(metro) || 0) + 1); zip3.set(prefix, tally);
}
// ZIP codes without a ZCTA (PO boxes, single-building ZIPs) fall back to their
// three-digit prefix only when at least 80% of that prefix's ZCTAs share a metro.
const prefixes = {};
for (const [prefix, tally] of [...zip3].sort()) {
    const total = [...tally.values()].reduce((sum, count) => sum + count, 0);
    const [metro, count] = [...tally].sort((a, b) => b[1] - a[1])[0];
    if (metro && count / total >= 0.8) prefixes[prefix] = metro;
}

// --- Occupations: SOC 2000 (O*NET 2009) and SOC 2010 codes to SOC 2018 ---
const six = code => code.slice(0, 7);
const words = title => new Set(title.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(word => word.length > 2));
function successor(code, title, targets) {
    if (targets.some(target => target.code === code)) return null;
    const score = target => target.title === title ? 2 : (() => {
        const a = words(title), b = words(target.title);
        const shared = [...a].filter(word => b.has(word)).length;
        return shared / (a.size + b.size - shared || 1);
    })();
    return [...targets].sort((a, b) => score(b) - score(a) || Number(b.code.slice(0, 2) === code.slice(0, 2)) - Number(a.code.slice(0, 2) === code.slice(0, 2)))[0].code;
}
function crosswalk(rows, from, fromTitle, to, toTitle) {
    const sources = new Map();
    for (const row of rows) {
        if (!row[from]?.endsWith('.00') || !row[to]) continue;
        const entry = sources.get(six(row[from])) || { title: row[fromTitle], targets: [] };
        if (!entry.targets.some(target => target.code === six(row[to]))) entry.targets.push({ code: six(row[to]), title: row[toTitle] });
        sources.set(six(row[from]), entry);
    }
    return sources;
}
const walk2010 = crosswalk(csv(await read('onet_2010_2019.csv')), 'O*NET-SOC 2010 Code', 'O*NET-SOC 2010 Title', 'O*NET-SOC 2019 Code', 'O*NET-SOC 2019 Title');
const walk2009 = crosswalk(csv(await read('onet_2009_2010.csv')), 'O*NET-SOC 2009 Code', 'O*NET-SOC 2009 Title', 'O*NET-SOC 2010 Code', 'O*NET-SOC 2010 Title');
const titles = {}, successors = {};
for (const entry of walk2010.values()) for (const target of entry.targets) titles[target.code] = target.title;
const current = new Set(Object.keys(titles));
for (const [code, entry] of walk2010) {
    if (current.has(code)) continue;
    const next = successor(code, entry.title, entry.targets);
    if (next) successors[code] = next;
    else titles[code] ||= entry.title;
}
for (const [code, entry] of walk2009) {
    if (current.has(code) || walk2010.has(code)) continue;
    const middle = successor(code, entry.title, entry.targets) || code;
    const next = current.has(middle) ? middle : successors[middle];
    if (next && next !== code) successors[code] = next;
}

// --- State shapes for the SVG map ---
const atlas = JSON.parse(await readFile(require.resolve('us-atlas/states-albers-10m.json'), 'utf8'));
const shapes = feature(atlas, atlas.objects.states).features;
const svgPath = geoPath(null).digits(1);
const states = shapes.map(shape => {
    const info = byFips.get(String(shape.id).padStart(2, '0'));
    if (!info) throw new Error('Unknown state shape ' + shape.id);
    const [cx, cy] = svgPath.centroid(shape);
    return { code: info.code, name: info.name, d: svgPath(shape), cx: round(cx), cy: round(cy) };
}).sort((a, b) => a.code.localeCompare(b.code));

// --- Counties: shapes per state for the zoomed map, and names, populations and points ---
// Census 2023 cartographic boundaries (1:5,000,000) in the same Albers USA
// coordinates as the state shapes, with more precision for close zooms.
const countyFeatures = [];
const shp = await shapefile.open(path.join(source, 'county/cb_2023_us_county_5m.shp'), path.join(source, 'county/cb_2023_us_county_5m.dbf'));
for (let next = await shp.read(); !next.done; next = await shp.read()) countyFeatures.push(next.value);
const projectedPath = geoPath(projection).digits(2);
const round2 = value => Math.round(value * 100) / 100;
const counties = [], countyFiles = new Map();
for (const shape of countyFeatures.sort((a, b) => a.properties.GEOID.localeCompare(b.properties.GEOID))) {
    const { GEOID: fips, NAMELSAD: name, STATEFP } = shape.properties;
    const state = byFips.get(STATEFP);
    if (!state) continue;
    const d = projectedPath(shape);
    const [cx, cy] = d ? projectedPath.centroid(shape) : [null, null];
    counties.push({ fips, state: state.code, name, population: countyPopulation.get(fips) || null,
        x: d ? round(cx) : null, y: d ? round(cy) : null });
    if (!d) continue;
    const bounds = projectedPath.bounds(shape).flat().map(round2);
    const file = countyFiles.get(state.code) || { code: state.code, features: [], counties: [] };
    file.features.push(shape);
    file.counties.push({ fips, name, d, cx: round2(cx), cy: round2(cy), box: bounds });
    countyFiles.set(state.code, file);
}
for (const file of countyFiles.values()) {
    const xs = file.counties.flatMap(county => [county.box[0], county.box[2]]), ys = file.counties.flatMap(county => [county.box[1], county.box[3]]);
    file.box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    // The state's outer edge, drawn once: county edges that belong to one county only.
    const shared = topology({ counties: { type: 'FeatureCollection', features: file.features } });
    file.outline = projectedPath(mesh(shared, shared.objects.counties, (a, b) => a === b));
    delete file.features;
}

// ZIP Code Tabulation Area points (2023 Gazetteer) with the county holding most of their land.
const zipPoints = {};
for (const row of table(await read('2023_Gaz_zcta_national.txt'), '\t')) {
    const county = zipCounty.get(row.GEOID);
    if (!county) continue;
    const point = projection([Number(row.INTPTLONG), Number(row.INTPTLAT)]);
    zipPoints[row.GEOID] = point ? [county, round2(point[0]), round2(point[1])] : [county, null, null];
}

const backendData = path.join(here, '../data/geo');
const frontendData = path.join(here, '../../frontend/src/data');
await mkdir(backendData, { recursive: true });
await mkdir(frontendData, { recursive: true });
const write = (file, value) => writeFile(file, JSON.stringify(value) + '\n');
const attribution = {
    geography: 'U.S. Census Bureau: 2020 ZCTA relationship files, July 2023 CBSA delineations, 2023 Gazetteer, 2023 cartographic boundary files, Vintage 2023 population estimates.',
    occupations: 'O*NET 2010 to 2019 and 2009 to 2010 Crosswalks, U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license.',
};
await write(path.join(backendData, 'metros.json'), { attribution: attribution.geography, metros: [...metros.values()].sort((a, b) => a.code.localeCompare(b.code)) });
await write(path.join(backendData, 'zip-metros.json'), { attribution: attribution.geography, zips, prefixes });
await write(path.join(backendData, 'states.json'), { attribution: attribution.geography, states: STATES.map(([fips, code, name]) => ({ fips, code, name, population: statePopulation.get(fips) || null })) });
await write(path.join(backendData, 'occupations.json'), { attribution: attribution.occupations, titles: Object.fromEntries(Object.entries(titles).sort()), successors: Object.fromEntries(Object.entries(successors).sort()) });
await write(path.join(backendData, 'counties.json'), { attribution: attribution.geography, counties });
await write(path.join(backendData, 'zips.json'), { attribution: attribution.geography, zips: zipPoints });
await mkdir(path.join(frontendData, 'counties'), { recursive: true });
for (const file of countyFiles.values())
    await write(path.join(frontendData, 'counties', file.code + '.json'), { attribution: 'U.S. Census Bureau 2023 cartographic boundary files.', ...file });
await write(path.join(frontendData, 'usStates.json'), { attribution: 'U.S. Census Bureau cartographic boundaries via us-atlas (ISC license).', width: 975, height: 610, states });
console.log({ counties: counties.length, countyFiles: countyFiles.size, zipPoints: Object.keys(zipPoints).length, metros: metros.size, zips: Object.keys(zips).length, prefixes: Object.keys(prefixes).length, occupations: Object.keys(titles).length, successors: Object.keys(successors).length, shapes: states.length, unnamedStates: [...byName.keys()].length });
