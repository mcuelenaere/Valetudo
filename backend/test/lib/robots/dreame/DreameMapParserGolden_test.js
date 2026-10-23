const assert = require("node:assert");
const fs = require("fs");
const { describe, it } = require("node:test");

const {
    computeGoldens,
    computeX40Goldens,
    GOLDEN_FILE,
    X40_GOLDEN_FILE,
    X40_MAP_FILE
} = require("../../../helpers/dreame_map_goldens");

function getX40SkipReason() {
    if (!fs.existsSync(X40_MAP_FILE)) {
        return `there is no map of a real robot at ${X40_MAP_FILE}, see --x40-map of util/bench_map_pipeline.js`;
    }

    if (!fs.existsSync(X40_GOLDEN_FILE)) {
        return "there are no hashes for it yet. Generate them with the code you want to compare against: node test/helpers/dreame_map_goldens.js --write";
    }

    return false;
}

describe("DreameMapParser golden output", () => {
    it("still produces exactly the same maps as 2026.10.0 for all fixtures and fuzzed frames", async () => {
        const expected = JSON.parse(fs.readFileSync(GOLDEN_FILE, { encoding: "utf-8" }));
        const actual = await computeGoldens();

        assert.deepStrictEqual(Object.keys(actual), Object.keys(expected));

        for (const [name, hash] of Object.entries(expected)) {
            assert.strictEqual(actual[name], hash, `The map parsed from ${name} differs from the golden one`);
        }
    });

    it("still produces exactly the same maps for frames built from the map of a real robot", { skip: getX40SkipReason() }, async () => {
        const expected = JSON.parse(fs.readFileSync(X40_GOLDEN_FILE, { encoding: "utf-8" }));
        const actual = await computeX40Goldens();

        assert.deepStrictEqual(actual, expected);
    });
});
