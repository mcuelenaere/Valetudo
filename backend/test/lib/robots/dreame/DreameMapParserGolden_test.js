const assert = require("node:assert");
const fs = require("fs");
const { describe, it } = require("node:test");

const { computeGoldens, GOLDEN_FILE } = require("../../../helpers/dreame_map_goldens");

describe("DreameMapParser golden output", () => {
    it("still produces exactly the same maps as 2026.10.0 for all fixtures, X40-sized frames and fuzzed frames", async () => {
        const expected = JSON.parse(fs.readFileSync(GOLDEN_FILE, { encoding: "utf-8" }));
        const actual = await computeGoldens();

        assert.deepStrictEqual(Object.keys(actual), Object.keys(expected));

        for (const [name, hash] of Object.entries(expected)) {
            assert.strictEqual(actual[name], hash, `The map parsed from ${name} differs from the golden one`);
        }
    });
});
