/*
    Benchmark for everything Valetudo does per map update while a Dreame robot is cleaning.

    Usage:
        node util/bench_map_pipeline.js [--json] [--quick] [--filter <text>] [--iterations <n>] [--budget-ms <ms>]
                                        [--warmup <n>] [--fixtures <dir>] [--report <result.json>]

        --json        Print only machine-readable JSON to stdout (progress goes to stderr)
        --quick       Smoke test: a handful of iterations per case
        --filter      Only run cases whose name contains the given text
        --iterations  Maximum number of timed iterations per case (default 100)
        --budget-ms   Stop a case after this much wall time once the minimum iterations are done (default 5000)
        --warmup      Untimed iterations per case (default 5)
        --fixtures    Additional directory of Dreame map frames (*.bin; base64url+zlib or already inflated)
        --report      Don't run anything, print the human-readable report for a result file written by --json

    For a copy that needs nothing but a node binary, run util/build_bench_bundle.js (writes ./bench) and then
        ./node bench/bench_map_pipeline.js --json > result.json

    Cases:
        parse/<fixture>      miio decode -> PREPROCESS (base64 + inflate) -> PARSE
        parse_path/<n>       DreameMapParser.PARSE_PATH for a trace string with n points
        listeners/<map>      everything that is hooked onto MapUpdated, as it is today:
                                 webserver SSE (state + map, evaluated even without clients),
                                 MQTT map-data + map-data-hass + the dedup hashing in MqttController.publish()
        mqtt_opt/<map>       MQTT only, one shared stringify + deflate, native zlib.crc32
        micro/<map>          the individual building blocks (stringify, deflate, crc, sha1)

    All timings are in ms per map update. "cpu" is process-wide user+system CPU time (all threads, so it includes
    zlib's threadpool work and V8's helper threads) divided by the number of iterations. "gc" is the time the
    PerformanceObserver reported for garbage collections during the timed loop; it is part of the wall times, too.
 */

// eslint-disable-next-line node/no-extraneous-require -- a dependency of the backend, which is what is being benchmarked
const crc = require("crc");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const v8 = require("v8");
const vm = require("vm");
const zlib = require("zlib");
const {constants: perfConstants, performance, PerformanceObserver} = require("perf_hooks");

const Codec = require("../backend/lib/miio/Codec");
const DreameMapParser = require("../backend/lib/robots/dreame/DreameMapParser");
const entities = require("../backend/lib/entities");
const KeyValueDeduplicationCache = require("../backend/lib/utils/KeyValueDeduplicationCache");
const MapNodeMqttHandle = require("../backend/lib/mqtt/handles/MapNodeMqttHandle");
const {SSEHub} = require("../backend/lib/webserver/middlewares/sse");

const FIXTURE_DIR = path.join(__dirname, "../backend/test/lib/robots/dreame/res/map");
const X40_MAP = path.join(__dirname, "res/bench_map_x40.json");
const PATH_SIZES = [2000, 5000, 10000];
const MAX_MIIO_PAYLOAD = 60000;
// Measured with the biggest fixture: PARSE needs roughly this much heap per map pixel at its peak
const PARSE_PEAK_BYTES_PER_PIXEL = 200;
const GC_KINDS = {
    [perfConstants.NODE_PERFORMANCE_GC_MINOR]: "minor",
    [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: "major",
    [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
    [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb"
};

// PNG wrapper of MapNodeMqttHandle, needed to build the "optimized" payload. Must stay in sync with MapNodeMqttHandle
const PNG_IMAGE = fs.readFileSync(path.join(__dirname, "../backend/lib/res/valetudo_home_assistant_mqtt_wrapper.png"));
const PNG_TEXT_CHUNK_TYPE = Buffer.from("zTXt");
const PNG_TEXT_CHUNK_METADATA = Buffer.from("ValetudoMap\0\0");
const PNG_IMAGE_WITHOUT_END_CHUNK = PNG_IMAGE.subarray(0, PNG_IMAGE.length - 12);
const PNG_END_CHUNK = PNG_IMAGE.subarray(PNG_IMAGE.length - 12);

const DEFAULT_CONFIG = {
    warmup: 5,
    minIterations: 10,
    maxIterations: 100,
    budgetMs: 5000
};
const QUICK_CONFIG = {
    warmup: 1,
    minIterations: 2,
    maxIterations: 3,
    budgetMs: 200
};


/**
 * @param {Array<number>} samples
 * @returns {{n: number, mean: number, p50: number, p95: number, min: number, max: number}}
 */
function stats(samples) {
    const sorted = [...samples].sort((a, b) => {
        return a - b;
    });
    const rank = (p) => {
        return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
    };

    return {
        n: sorted.length,
        mean: sorted.reduce((a, b) => {
            return a + b;
        }, 0) / sorted.length,
        p50: rank(0.5),
        p95: rank(0.95),
        min: sorted[0],
        max: sorted[sorted.length - 1]
    };
}

function mulberry32(seed) {
    let a = seed;

    return function() {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function getGcFunction() {
    if (typeof global.gc === "function") {
        return global.gc;
    }

    try {
        v8.setFlagsFromString("--expose-gc");

        return vm.runInNewContext("gc");
    } catch (e) {
        return null;
    }
}

const gcFunction = getGcFunction();

/**
 * Runs one benchmark case.
 *
 * Everything a case needs is created in its setup() and dropped afterwards. That keeps the live heap about as small
 * as in Valetudo itself, which matters because the robot runs with a heap limit of 64 MB.
 *
 * @param {object} definition
 * @param {string} definition.name
 * @param {() => Promise<{params: object, iteration: (lap: (name: string, work: () => any) => Promise<any>) => Promise<void>}>} definition.setup
 * @param {typeof DEFAULT_CONFIG} config
 * @returns {Promise<object>}
 */
async function runCase(definition, config) {
    const {params, iteration} = await definition.setup();
    const samples = {};
    const totals = [];
    const recordingLap = async (name, work) => {
        const start = performance.now();
        const result = await work();

        (samples[name] ??= []).push(performance.now() - start);

        return result;
    };
    const silentLap = async (name, work) => {
        return work();
    };

    for (let i = 0; i < config.warmup; i++) {
        await iteration(silentLap);
    }

    if (gcFunction) {
        gcFunction();
    }

    const gcEntries = [];
    const gcObserver = new PerformanceObserver((list) => {
        gcEntries.push(...list.getEntries());
    });
    gcObserver.observe({entryTypes: ["gc"]});

    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();

    while (
        totals.length < config.minIterations ||
        (totals.length < config.maxIterations && performance.now() - wallStart < config.budgetMs)
    ) {
        const start = performance.now();

        await iteration(recordingLap);

        totals.push(performance.now() - start);
    }

    const cpu = process.cpuUsage(cpuStart);

    // GC performance entries are delivered asynchronously
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
    gcEntries.push(...gcObserver.takeRecords());
    gcObserver.disconnect();

    const gc = {
        count: gcEntries.length,
        totalMs: 0,
        msPerIteration: 0,
        byKind: {}
    };

    for (const entry of gcEntries) {
        const kind = GC_KINDS[entry.detail?.kind ?? entry.kind] ?? "other";

        gc.totalMs += entry.duration;
        gc.byKind[kind] ??= {count: 0, totalMs: 0};
        gc.byKind[kind].count++;
        gc.byKind[kind].totalMs += entry.duration;
    }
    gc.msPerIteration = gc.totalMs / totals.length;

    const laps = {};
    for (const [name, values] of Object.entries(samples)) {
        laps[name] = stats(values);
    }

    return {
        name: definition.name,
        params: params,
        iterations: totals.length,
        total: stats(totals),
        laps: laps,
        cpuMsPerIteration: (cpu.user + cpu.system) / 1000 / totals.length,
        gc: gc
    };
}

function toBase64Url(data) {
    return zlib.deflateSync(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * @param {string} name
 * @param {string} base64
 * @param {Buffer|null} inflated
 * @param {object} extraParams
 * @returns {Promise<null|{name: string, base64: string, inflated: Buffer, layers: number, entities: number, pixels: number, extraParams: object}>}
 */
async function describeFixture(name, base64, inflated, extraParams) {
    let parsed = null;

    try {
        parsed = inflated ? await DreameMapParser.PARSE(inflated) : null;
    } catch (e) {
        // intentional
    }

    if (!parsed) {
        return null; // Header-only or invalid frames are of no interest here
    }

    return {
        name: name,
        base64: base64,
        inflated: inflated,
        layers: parsed.layers.length,
        entities: parsed.entities.length,
        pixels: parsed.layers.reduce((sum, l) => {
            return sum + l.dimensions.pixelCount;
        }, 0),
        extraParams: extraParams
    };
}

/**
 * @param {Array<string>} dirs
 * @returns {Promise<Array<object>>}
 */
async function loadFixtures(dirs) {
    const fixtures = [];

    for (const dir of dirs) {
        for (const file of fs.readdirSync(dir).filter(f => {
            return f.endsWith(".bin");
        }).sort()) {
            const data = fs.readFileSync(path.join(dir, file));
            const isBase64 = /^[A-Za-z0-9_-]{64}/.test(data.subarray(0, 64).toString("latin1"));
            const fixture = await describeFixture(
                file.replace(/\.bin$/, ""),
                // If it isn't, it's not what the robot would send, but the same kind of data and about the same size
                isBase64 ? data.toString() : toBase64Url(data),
                isBase64 ? await DreameMapParser.PREPROCESS(data) : data,
                {base64Encoded: isBase64}
            );

            if (fixture) {
                fixtures.push(fixture);
            }
        }
    }

    return fixtures;
}

const DREAME_MATERIALS = {generic: 0, wood_horizontal: 1, wood_vertical: 1, tile: 2, carpet_high: 5, carpet_low: 6, carpet: 7};
const FRAME_MARGIN = 5;
const HEADER_SIZE = 27;
const FRAME_TYPE_I = 73;
const SAVED_MAP_WALL_FLAG = 0x80;

/**
 * The reverse of DreameMapParser.PARSE: builds the frame a robot would send for the given map.
 * Everything that isn't a room, a wall or the robot/charger position is left out.
 *
 * @param {import("../backend/lib/entities/map/ValetudoMap")} map
 * @param {string} trace
 * @param {boolean} withSavedMap Whether to embed the saved map ("rism") as robots with a saved map do
 * @returns {Buffer}
 */
function buildDreameFrame(map, trace, withSavedMap) {
    const pixelSize = map.pixelSize;
    const bounds = {minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity};

    for (const layer of map.layers) {
        bounds.minX = Math.min(bounds.minX, layer.dimensions.x.min);
        bounds.maxX = Math.max(bounds.maxX, layer.dimensions.x.max);
        bounds.minY = Math.min(bounds.minY, layer.dimensions.y.min);
        bounds.maxY = Math.max(bounds.maxY, layer.dimensions.y.max);
    }

    // See PARSE_IMAGE for the coordinate transformation. Left and top are chosen as multiples of the pixel size
    const y0 = Math.round(map.size.y / pixelSize);
    const left = bounds.minX - FRAME_MARGIN;
    const top = y0 - bounds.maxY - FRAME_MARGIN;
    const width = bounds.maxX - bounds.minX + 2 * FRAME_MARGIN + 1;
    const height = bounds.maxY - bounds.minY + 2 * FRAME_MARGIN + 1;

    const header = Buffer.alloc(HEADER_SIZE);
    const position = (type) => {
        const entity = map.entities.find(e => {
            return e.type === type;
        });

        return DreameMapParser.CONVERT_TO_DREAME_COORDINATES(entity.points[0], entity.points[1]);
    };
    const robot = position("robot_position");
    const charger = position("charger_location");

    header.writeInt16LE(1, 0);
    header.writeInt16LE(1, 2);
    header.writeInt8(FRAME_TYPE_I, 4);
    header.writeInt16LE(robot.x, 5);
    header.writeInt16LE(robot.y, 7);
    header.writeInt16LE(charger.x, 11);
    header.writeInt16LE(charger.y, 13);
    header.writeInt16LE(pixelSize * 10, 17);
    header.writeInt16LE(width, 19);
    header.writeInt16LE(height, 21);
    header.writeInt16LE(left * pixelSize * 10 - DreameMapParser.HALF_INT16, 23);
    header.writeInt16LE(top * pixelSize * 10 - DreameMapParser.HALF_INT16, 25);

    const pixels = Buffer.alloc(width * height);
    const savedMapPixels = Buffer.alloc(width * height);
    const segmentInfo = {};

    for (const layer of map.layers) {
        const isWall = layer.type === "wall";
        const segmentId = isWall ? 0 : parseInt(layer.metaData.segmentId);

        for (let k = 0; k < layer.compressedPixels.length; k += 3) {
            const row = y0 - top - layer.compressedPixels[k + 1];

            for (let c = 0; c < layer.compressedPixels[k + 2]; c++) {
                const index = row * width + layer.compressedPixels[k] + c - left;

                pixels[index] = isWall ? 2 : (segmentId << 2) | 1;
                savedMapPixels[index] = isWall ? SAVED_MAP_WALL_FLAG : segmentId;
            }
        }

        if (!isWall) {
            segmentInfo[segmentId] = {
                name: Buffer.from(layer.metaData.name ?? `Room ${segmentId}`).toString("base64"),
                material: DREAME_MATERIALS[layer.metaData.material] ?? 0
            };
        }
    }

    const additionalData = {curid: 1, seg_inf: segmentInfo, tr: trace};

    if (withSavedMap) {
        additionalData.ris = 2;
        additionalData.rism = toBase64Url(Buffer.concat([header, savedMapPixels, Buffer.from("{}")]));
    }

    return Buffer.concat([header, pixels, Buffer.from(JSON.stringify(additionalData))]);
}

/**
 * Frames for the real X40 map. The path of a cleaning robot is part of every frame it sends
 *
 * @returns {Promise<Array<object>>}
 */
async function buildX40Fixtures() {
    const fixtures = [];
    const trace = generateTraceString(5000);

    for (const withSavedMap of [false, true]) {
        const map = entities.map.ValetudoMap.DESERIALIZE(JSON.parse(fs.readFileSync(X40_MAP, "utf8")));
        const inflated = buildDreameFrame(map, trace, withSavedMap);
        const fixture = await describeFixture(
            withSavedMap ? "x40_frame_with_saved_map" : "x40_frame",
            toBase64Url(inflated),
            inflated,
            {synthetic: true, tracePoints: 5000, savedMap: withSavedMap}
        );
        const expectedPixels = map.layers.reduce((sum, l) => {
            return sum + l.dimensions.pixelCount;
        }, 0);

        // A handful of pixels are part of two layers in the original, but a frame can only have one value per pixel
        if (!fixture || Math.abs(fixture.pixels - expectedPixels) > expectedPixels / 200 || fixture.layers !== map.layers.length) {
            throw new Error("The synthetic X40 frame does not parse back to the X40 map");
        }

        fixtures.push(fixture);
    }

    return fixtures;
}

/**
 * A robot-shaped sweep: back and forth in rows over the bounding box of all room layers.
 * The jitter keeps it from compressing unrealistically well
 *
 * @param {import("../backend/lib/entities/map/ValetudoMap")} map
 * @param {number} pointCount
 * @returns {Array<number>} flat x,y list in cm
 */
function generateSweepPoints(map, pointCount) {
    const random = mulberry32(pointCount);
    const bounds = {minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity};

    for (const layer of map.layers) {
        bounds.minX = Math.min(bounds.minX, layer.dimensions.x.min * map.pixelSize);
        bounds.maxX = Math.max(bounds.maxX, layer.dimensions.x.max * map.pixelSize);
        bounds.minY = Math.min(bounds.minY, layer.dimensions.y.min * map.pixelSize);
        bounds.maxY = Math.max(bounds.maxY, layer.dimensions.y.max * map.pixelSize);
    }

    const points = [];
    let y = bounds.minY;
    let direction = 1;
    let x = bounds.minX;

    while (points.length / 2 < pointCount) {
        points.push(Math.round(x + (random() - 0.5) * 4), Math.round(y + (random() - 0.5) * 6));

        x += direction * (6 + random() * 3);

        if (x > bounds.maxX || x < bounds.minX) {
            direction *= -1;
            x = Math.min(bounds.maxX, Math.max(bounds.minX, x));
            y += 30;

            if (y > bounds.maxY) {
                y = bounds.minY;
            }
        }
    }

    return points;
}

/**
 * The robot sends the trace as "S<x>,<y>L<dx>,<dy>L<dx>,<dy>..." with a unit of 1mm
 *
 * @param {number} pointCount
 * @returns {string}
 */
function generateTraceString(pointCount) {
    const random = mulberry32(pointCount + 1);
    const parts = ["S-1203,2410"];

    for (let i = 1; i < pointCount; i++) {
        parts.push(`L${Math.round((random() - 0.4) * 160)},${Math.round((random() - 0.5) * 120)}`);
    }

    return parts.join("");
}

/**
 * @returns {Array<{name: string, pathPoints: number, create: () => Promise<any>}>}
 */
function getX40MapSpecs() {
    const raw = fs.readFileSync(X40_MAP, "utf8");
    const variants = [{name: "x40_docked", pathPoints: 0}, ...PATH_SIZES.map(n => {
        return {name: `x40_path${n / 1000}k`, pathPoints: n};
    })];

    return variants.map(variant => {
        return {
            name: variant.name,
            pathPoints: variant.pathPoints,
            create: async () => {
                // The same thing PhoenixManager does when restoring a map
                const map = entities.map.ValetudoMap.DESERIALIZE(JSON.parse(raw));

                if (variant.pathPoints > 0) {
                    map.addEntity(new entities.map.PathMapEntity({
                        points: generateSweepPoints(map, variant.pathPoints),
                        type: entities.map.PathMapEntity.TYPE.PATH
                    }));
                }

                return map;
            }
        };
    });
}

function buildState(map) {
    const attributes = entities.state.attributes;

    return new entities.state.RobotState({
        map: map,
        attributes: [
            new attributes.BatteryStateAttribute({level: 71, flag: attributes.BatteryStateAttribute.FLAG.DISCHARGING}),
            new attributes.StatusStateAttribute({value: attributes.StatusStateAttribute.VALUE.CLEANING}),
            new attributes.DockStatusStateAttribute({value: attributes.DockStatusStateAttribute.VALUE.IDLE}),
            new attributes.PresetSelectionStateAttribute({type: "fan_speed", value: "high"}),
            new attributes.PresetSelectionStateAttribute({type: "water_grade", value: "medium"}),
            new attributes.PresetSelectionStateAttribute({type: "operation_mode", value: "vacuum_and_mop"}),
            new attributes.AttachmentStateAttribute({type: "dustbin", attached: true}),
            new attributes.AttachmentStateAttribute({type: "watertank", attached: true}),
            new attributes.AttachmentStateAttribute({type: "mop", attached: true})
        ]
    });
}

/**
 * Same payloads as MapNodeMqttHandle#getMapData, but stringified and deflated only once
 *
 * @param {import("../backend/lib/entities/map/ValetudoMap")} map
 * @returns {Promise<{mapData: Buffer, mapDataHass: Buffer}>}
 */
async function getMapDataShared(map) {
    const deflated = await new Promise((resolve, reject) => {
        zlib.deflate(JSON.stringify(map), (err, buf) => {
            return err ? reject(err) : resolve(buf);
        });
    });

    const length = Buffer.alloc(4);
    const checksum = Buffer.alloc(4);
    const textChunkData = Buffer.concat([PNG_TEXT_CHUNK_TYPE, PNG_TEXT_CHUNK_METADATA, deflated]);

    length.writeInt32BE(PNG_TEXT_CHUNK_METADATA.length + deflated.length, 0);
    checksum.writeUInt32BE(zlib.crc32(textChunkData), 0);

    return {
        mapData: deflated,
        mapDataHass: Buffer.concat([PNG_IMAGE_WITHOUT_END_CHUNK, length, textChunkData, checksum, PNG_END_CHUNK])
    };
}

/**
 * @param {Array<{name: string, pathPoints: number, create: () => Promise<any>}>} mapSpecs
 * @returns {Array<{name: string, setup: () => Promise<any>}>}
 */
function buildDownstreamCases(mapSpecs) {
    const cases = [];

    // Creates the map for one case and everything that is derived from it
    const prepare = async (spec) => {
        const map = await spec.create();
        const state = buildState(map);
        // Everything MapNodeMqttHandle#getMapData needs, without the rest of the mqtt machinery
        const mapHandle = Object.assign(Object.create(MapNodeMqttHandle.prototype), {
            robot: {state: state},
            controller: {isInitialized: true},
            deflatedMapData: null
        });
        const getMapData = (wrapInPng) => {
            return mapHandle["getMapData"](wrapInPng);
        };

        const today = {mapData: await getMapData(false), mapDataHass: await getMapData(true)};
        const shared = await getMapDataShared(map);

        if (!today.mapData.equals(shared.mapData) || !today.mapDataHass.equals(shared.mapDataHass)) {
            throw new Error(`The shared MQTT payloads differ from the current ones for ${spec.name}`);
        }
        if (crc.crc32(today.mapData) !== zlib.crc32(today.mapData)) {
            throw new Error("zlib.crc32 and crc.crc32 disagree");
        }

        return {
            map: map,
            state: state,
            mapHandle: mapHandle,
            getMapData: getMapData,
            params: {
                pathPoints: spec.pathPoints,
                mapJsonBytes: Buffer.byteLength(JSON.stringify(map)),
                mapDeflatedBytes: today.mapData.length,
                mapHassPngBytes: today.mapDataHass.length,
                stateJsonBytes: Buffer.byteLength(JSON.stringify(state)),
                layers: map.layers.length,
                entities: map.entities.length
            }
        };
    };

    for (const spec of mapSpecs) {
        cases.push({
            name: `listeners/${spec.name}`,
            setup: async () => {
                const {state, mapHandle, getMapData, params} = await prepare(spec);
                const stateHub = new SSEHub({name: "State"});
                const mapHub = new SSEHub({name: "Map"});
                const cache = new KeyValueDeduplicationCache({});

                return {
                    params: params,
                    iteration: async (lap) => {
                        // MapNodeMqttHandle#onMapUpdated() drops what it cached of the previous map
                        mapHandle.deflatedMapData = null;

                        // RobotRouter: onStateUpdated + onMapUpdated. The arguments are evaluated even if nobody listens
                        await lap("sse_state", () => {
                            stateHub.event("StateUpdated", JSON.stringify(state));
                        });
                        await lap("sse_map", () => {
                            mapHub.event("MapUpdated", JSON.stringify(state.map));
                        });

                        // MapNodeMqttHandle#refresh(): map-data, map-data-hass
                        const mapData = await lap("mqtt_map_data", () => {
                            return getMapData(false);
                        });
                        const mapDataHass = await lap("mqtt_map_data_hass", () => {
                            return getMapData(true);
                        });
                        // MqttController#publish() hashes every payload to find out if it changed
                        await lap("mqtt_dedupe", () => {
                            cache.update("valetudo/robot/MapData/map-data", mapData);
                            cache.update("valetudo/robot/MapData/map-data-hass", mapDataHass);
                        });
                    }
                };
            }
        });

        cases.push({
            name: `mqtt_opt/${spec.name}`,
            setup: async () => {
                const {state, params} = await prepare(spec);
                const cache = new KeyValueDeduplicationCache({});

                return {
                    params: params,
                    iteration: async (lap) => {
                        const payloads = await lap("mqtt_payloads", () => {
                            return getMapDataShared(state.map);
                        });
                        await lap("mqtt_dedupe", () => {
                            cache.update("valetudo/robot/MapData/map-data", payloads.mapData);
                            cache.update("valetudo/robot/MapData/map-data-hass", payloads.mapDataHass);
                        });
                    }
                };
            }
        });

        cases.push({
            name: `micro/${spec.name}`,
            setup: async () => {
                const {map, params} = await prepare(spec);

                return {
                    params: params,
                    iteration: async (lap) => {
                        const stringified = await lap("stringify", () => {
                            return JSON.stringify(map);
                        });
                        const deflated = await lap("deflate", () => {
                            return new Promise((resolve, reject) => {
                                zlib.deflate(stringified, (err, buf) => {
                                    return err ? reject(err) : resolve(buf);
                                });
                            });
                        });
                        const chunk = await lap("png_concat", () => {
                            return Buffer.concat([PNG_TEXT_CHUNK_TYPE, PNG_TEXT_CHUNK_METADATA, deflated]);
                        });
                        await lap("crc32_js", () => {
                            return crc.crc32(chunk);
                        });
                        await lap("crc32_native", () => {
                            return zlib.crc32(chunk);
                        });
                        await lap("sha1_dedupe_hash", () => {
                            return crypto.createHash("sha1").update(deflated).digest("hex");
                        });
                    }
                };
            }
        });
    }

    return cases;
}

/**
 * @param {Array<any>} fixtures
 * @returns {Array<{name: string, setup: () => Promise<any>}>}
 */
function buildParseCases(fixtures) {
    const cases = [];

    for (const fixture of fixtures) {
        cases.push({
            name: `parse/${fixture.name}`,
            setup: async () => {
                const codec = new Codec({token: Buffer.from("0123456789abcdef")});
                // What the robot answers to the poll, as it arrives on the dummycloud socket.
                // A miio packet is a single UDP datagram, so frames that don't fit can't be sent by a real robot this way
                const packet = fixture.base64.length < MAX_MIIO_PAYLOAD ? codec.encodeOutgoingMiioPacket({
                    id: 4711,
                    result: {
                        code: 0,
                        out: [{siid: 6, piid: 1, value: fixture.base64}]
                    }
                }, 123456789) : null;

                return {
                    params: {
                        base64Bytes: fixture.base64.length,
                        inflatedBytes: fixture.inflated.length,
                        miioPacketBytes: packet?.length ?? null,
                        layers: fixture.layers,
                        entities: fixture.entities,
                        pixels: fixture.pixels,
                        ...fixture.extraParams
                    },
                    iteration: async (lap) => {
                        let value = fixture.base64;

                        if (packet) {
                            const decoded = await lap("miio_decode", () => {
                                return codec.decodeIncomingMiioPacket(packet);
                            });

                            value = decoded.msg.result.out[0].value;
                        }

                        const inflated = await lap("preprocess", () => {
                            return DreameMapParser.PREPROCESS(value);
                        });

                        await lap("parse", () => {
                            return DreameMapParser.PARSE(inflated);
                        });
                    }
                };
            }
        });
    }

    for (const n of PATH_SIZES) {
        cases.push({
            name: `parse_path/${n / 1000}k`,
            setup: async () => {
                const trace = generateTraceString(n);
                const header = {robot_position: {x: 3000, y: 3000}};

                return {
                    params: {traceBytes: trace.length, points: n},
                    iteration: async (lap) => {
                        await lap("parse_path", () => {
                            return DreameMapParser.PARSE_PATH(header, trace, true);
                        });
                    }
                };
            }
        });
    }

    return cases;
}

/**
 * @param {object} options
 * @param {boolean} [options.quick]
 * @param {string} [options.filter]
 * @param {number} [options.iterations]
 * @param {number} [options.budgetMs]
 * @param {number} [options.warmup]
 * @param {Array<string>} [options.fixtureDirs]
 * @param {(line: string) => void} [options.progress]
 * @returns {Promise<object>}
 */
async function run(options = {}) {
    const config = Object.assign({}, options.quick ? QUICK_CONFIG : DEFAULT_CONFIG);
    const progress = options.progress ?? (() => {});

    if (options.iterations !== undefined) {
        config.maxIterations = options.iterations;
        config.minIterations = Math.min(config.minIterations, options.iterations);
    }
    if (options.budgetMs !== undefined) {
        config.budgetMs = options.budgetMs;
    }
    if (options.warmup !== undefined) {
        config.warmup = options.warmup;
    }

    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    const skipped = [];
    // Running out of heap is fatal, so with a small heap limit (e.g. 64 MB like the robot) maps that cannot be parsed are skipped
    const fixtures = [
        ...(await loadFixtures([FIXTURE_DIR, ...(options.fixtureDirs ?? [])])),
        ...(await buildX40Fixtures())
    ].filter(f => {
        if (f.pixels * PARSE_PEAK_BYTES_PER_PIXEL > heapLimit) {
            skipped.push(`${f.name}: ${f.pixels} pixels need ~${Math.round(f.pixels * PARSE_PEAK_BYTES_PER_PIXEL / 1048576)} MB to parse, heap limit is ${Math.round(heapLimit / 1048576)} MB`);

            return false;
        }

        return true;
    });
    const mapSpecs = [
        ...getX40MapSpecs(),
        // The two biggest maps of the Dreame fixtures
        ...fixtures.filter(f => {
            return ["d9_1093_huge", "l10su_3031_giant"].includes(f.name);
        }).map(f => {
            return {
                name: f.name,
                pathPoints: 0,
                create: async () => {
                    return DreameMapParser.PARSE(f.inflated);
                }
            };
        })
    ];

    const definitions = [
        ...buildParseCases(fixtures),
        ...buildDownstreamCases(mapSpecs)
    ].filter(d => {
        return !options.filter || d.name.includes(options.filter);
    });

    const results = [];
    for (const definition of definitions) {
        progress(`[${results.length + 1}/${definitions.length}] ${definition.name}`);
        results.push(await runCase(definition, config));
    }

    const cpus = os.cpus();

    return {
        meta: {
            date: new Date().toISOString(),
            node: process.version,
            v8: process.versions.v8,
            zlib: process.versions.zlib,
            arch: process.arch,
            platform: process.platform,
            kernel: os.release(),
            cpuModel: cpus[0]?.model,
            cpuCount: cpus.length,
            totalMemMB: Math.round(os.totalmem() / 1048576),
            execArgv: process.execArgv,
            gcFunctionAvailable: gcFunction !== null,
            heapLimitMB: Math.round(heapLimit / 1048576),
            skipped: skipped,
            config: config
        },
        cases: results
    };
}

function formatMs(value) {
    return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function formatReport(report) {
    const lines = [];
    const meta = report.meta;

    lines.push(`node ${meta.node} (V8 ${meta.v8}, zlib ${meta.zlib}) on ${meta.platform}/${meta.arch}, ${meta.cpuCount}x ${meta.cpuModel}`);
    lines.push(`heap limit ${meta.heapLimitMB} MB, gc() ${meta.gcFunctionAvailable ? "available" : "NOT available"}, execArgv ${JSON.stringify(meta.execArgv)}`);
    for (const skipped of meta.skipped) {
        lines.push(`SKIPPED ${skipped}`);
    }
    lines.push("All values in ms per map update. cpu = process-wide cpu time per iteration, gc = gc time per iteration");

    for (const c of report.cases) {
        lines.push("");
        lines.push(`${c.name}  (${c.iterations} iterations)  ${JSON.stringify(c.params)}`);
        lines.push(`  ${"stage".padEnd(22)}${"mean".padStart(9)}${"p50".padStart(9)}${"p95".padStart(9)}`);

        for (const [name, s] of [...Object.entries(c.laps), ["TOTAL (wall)", c.total]]) {
            lines.push(`  ${name.padEnd(22)}${formatMs(s.mean).padStart(9)}${formatMs(s.p50).padStart(9)}${formatMs(s.p95).padStart(9)}`);
        }

        lines.push(`  cpu ${formatMs(c.cpuMsPerIteration)}  gc ${formatMs(c.gc.msPerIteration)} (${c.gc.count} collections: ${
            Object.entries(c.gc.byKind).map(([kind, v]) => {
                return `${v.count} ${kind}`;
            }).join(", ") || "none"
        })`);
    }

    return lines.join("\n");
}

function parseArguments(argv) {
    const options = {fixtureDirs: []};

    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--json":
                options.json = true;
                break;
            case "--quick":
                options.quick = true;
                break;
            case "--filter":
                options.filter = argv[++i];
                break;
            case "--iterations":
                options.iterations = parseInt(argv[++i]);
                break;
            case "--budget-ms":
                options.budgetMs = parseInt(argv[++i]);
                break;
            case "--warmup":
                options.warmup = parseInt(argv[++i]);
                break;
            case "--fixtures":
                options.fixtureDirs.push(path.resolve(argv[++i]));
                break;
            case "--report":
                options.report = argv[++i];
                break;
            default:
                throw new Error(`Unknown argument ${argv[i]}`);
        }
    }

    return options;
}

async function main(argv) {
    const options = parseArguments(argv);

    if (options.report) {
        process.stdout.write(formatReport(JSON.parse(fs.readFileSync(options.report, "utf8"))) + "\n");

        return;
    }

    try {
        const report = await run(Object.assign(options, {
            progress: (line) => {
                process.stderr.write(line + "\n");
            }
        }));

        process.stdout.write((options.json ? JSON.stringify(report, null, 2) : formatReport(report)) + "\n");
    } catch (err) {
        process.stderr.write(`${err.stack ?? err}\n`);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main(process.argv.slice(2));
}

module.exports = {
    buildX40Fixtures: buildX40Fixtures,
    formatReport: formatReport,
    main: main,
    run: run
};
