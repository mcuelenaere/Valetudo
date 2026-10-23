const assert = require("node:assert");
const crc = require("crc");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { describe, it } = require("node:test");

const DreameMapParser = require("../../../../lib/robots/dreame/DreameMapParser");
const MapNodeMqttHandle = require("../../../../lib/mqtt/handles/MapNodeMqttHandle");

const FIXTURE_DIR = path.join(__dirname, "../../robots/dreame/res/map");
const PNG = fs.readFileSync(path.join(__dirname, "../../../../lib/res/valetudo_home_assistant_mqtt_wrapper.png"));

// The implementation of 2026.10.0
function referenceGetMapData(map, wrapInPng) {
    return new Promise((resolve, reject) => {
        zlib.deflate(JSON.stringify(map), (err, buf) => {
            if (err !== null) {
                return reject(err);
            }

            if (!wrapInPng) {
                return resolve(buf);
            }

            const length = Buffer.alloc(4);
            const checksum = Buffer.alloc(4);
            const textChunkData = Buffer.concat([Buffer.from("zTXt"), Buffer.from("ValetudoMap\0\0"), buf]);

            length.writeInt32BE(Buffer.from("ValetudoMap\0\0").length + buf.length, 0);
            checksum.writeUInt32BE(crc.crc32(textChunkData), 0);

            resolve(Buffer.concat([
                PNG.subarray(0, PNG.length - 12),
                length,
                textChunkData,
                checksum,
                PNG.subarray(PNG.length - 12)
            ]));
        });
    });
}

async function loadMaps() {
    const maps = [];

    for (const file of ["d9_1093_huge.bin", "z10_1056_paths.bin", "l10su_1121_carpet.bin"]) {
        maps.push(await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(fs.readFileSync(path.join(FIXTURE_DIR, file)))));
    }

    return maps;
}

function createHandle(state, isInitialized = true) {
    const handle = Object.create(MapNodeMqttHandle.prototype);

    handle.robot = {state: state};
    handle.controller = {isInitialized: isInitialized};
    handle.deflatedMapData = null;

    return handle;
}

describe("MapNodeMqttHandle", () => {
    it("creates exactly the same payloads for map-data and map-data-hass as before", async () => {
        for (const map of await loadMaps()) {
            const handle = createHandle({map: map});

            assert.deepStrictEqual(await handle.getMapData(false), await referenceGetMapData(map, false));
            assert.deepStrictEqual(await handle.getMapData(true), await referenceGetMapData(map, true));
        }
    });

    it("stringifies and deflates the map only once for both of them", async () => {
        const [map] = await loadMaps();
        const handle = createHandle({map: map});
        const originalDeflate = zlib.deflate;
        let deflateCalls = 0;

        zlib.deflate = (...args) => {
            deflateCalls++;

            return originalDeflate(...args);
        };

        try {
            await handle.getMapData(false);
            await handle.getMapData(true);
            assert.strictEqual(deflateCalls, 1);

            // A new map, which is what every map update brings
            const state = handle.robot.state;
            state.map = (await loadMaps())[1];
            await handle.getMapData(true);
            await handle.getMapData(false);
            assert.strictEqual(deflateCalls, 2);

            // The same map object that has been changed in place, announced by the map update
            state.map.entities.pop();
            handle.controller.isInitialized = false; // so that it doesn't try to publish anything
            handle.onMapUpdated();
            handle.controller.isInitialized = true;
            assert.deepStrictEqual(await handle.getMapData(false), await referenceGetMapData(state.map, false));
            assert.strictEqual(deflateCalls, 4); // The reference implementation deflated, too
        } finally {
            zlib.deflate = originalDeflate;
        }
    });

    it("has no data without a map or before the mqtt controller is initialized", async () => {
        const [map] = await loadMaps();

        assert.strictEqual(await createHandle({map: null}).getMapData(false), null);
        assert.strictEqual(await createHandle({map: map}, false).getMapData(true), null);
    });
});
