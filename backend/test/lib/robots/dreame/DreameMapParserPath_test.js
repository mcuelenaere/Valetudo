const assert = require("node:assert");
const { describe, it } = require("node:test");

const DreameMapParser = require("../../../../lib/robots/dreame/DreameMapParser");

/**
 * The implementation of 2026.10.0
 */
const REFERENCE_PATH_REGEX = /(?<operator>[SMWL])(?<x>-?\d+),(?<y>-?\d+)/g;
function referenceParsePath(parsedHeader, traceString, appendRobotPosition) {
    const unprocessedPaths = [];
    let currentUnprocessedPath = undefined;
    let currentPosition = {x: 0, y: 0};
    let match;

    REFERENCE_PATH_REGEX.lastIndex = 0;
    while ((match = REFERENCE_PATH_REGEX.exec(traceString)) !== null) {
        if (["S", "M", "W"].includes(match.groups.operator)) {
            currentUnprocessedPath = [];
            unprocessedPaths.push(currentUnprocessedPath);

            currentPosition.x = parseInt(match.groups.x);
            currentPosition.y = parseInt(match.groups.y);
        } else {
            currentPosition.x += parseInt(match.groups.x);
            currentPosition.y += parseInt(match.groups.y);
        }

        currentUnprocessedPath.push({x: currentPosition.x, y: currentPosition.y});
    }

    return unprocessedPaths.map((unprocessedPoints, i) => {
        const points = [];

        unprocessedPoints.forEach(e => {
            const p = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(e.x, e.y);

            points.push(p.x, p.y);
        });

        if (i === unprocessedPaths.length - 1 && appendRobotPosition) {
            points.push(parsedHeader.robot_position.x, parsedHeader.robot_position.y);
        }

        return {__class: "PathMapEntity", metaData: {}, points: points, type: "path"};
    });
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

function run(fn, header, trace, append) {
    try {
        return JSON.parse(JSON.stringify(fn(header, trace, append)));
    } catch (e) {
        return `${e.constructor.name}`;
    }
}

describe("DreameMapParser.PARSE_PATH", () => {
    const header = {robot_position: {x: 3000, y: 3000}};

    it("parses traces like the regex based implementation of 2026.10.0", () => {
        const alphabet = ["S", "M", "W", "L", "L", "L", "-", "-", ",", ",", "0", "1", "7", "9", "12", "345", " ", "x", "\n", "99999999999999999999"];
        const random = mulberry32(42);

        for (let i = 0; i < 4000; i++) {
            let trace = i % 3 === 0 ? "S-12,34" : "";

            for (let n = Math.floor(random() * 40); n > 0; n--) {
                // Mostly valid operations with some garbage in between
                trace += random() < 0.7 ?
                    `${"SMWLLLLL"[Math.floor(random() * 8)]}${Math.floor((random() - 0.5) * 3000)},${Math.floor((random() - 0.5) * 3000)}` :
                    alphabet[Math.floor(random() * alphabet.length)];
            }

            for (const append of [false, true]) {
                assert.deepStrictEqual(
                    run(DreameMapParser.PARSE_PATH, header, trace, append),
                    run(referenceParsePath, header, trace, append),
                    JSON.stringify(trace)
                );
            }
        }
    });

    it("parses special cases like the regex based implementation of 2026.10.0", () => {
        for (const trace of [
            "", "S", "S1", "S1,", "S1,2", "S-,5", "S5,-", "S-0,-0L-0,-0", "Sa1,2", "S1;2", "L1,2", "L1,2S1,2",
            "S100,200L1,2M300,400L-5,5W1,1L2,2", "S1,2L3,4,5L6,7", "S 1,2", "s1,2", "S01,002", "SS1,2", "S1,2-3,4",
            "S12345678901234567890,1", "S1,2L99999999999999999999,1", undefined, null, 123, {}
        ]) {
            for (const append of [false, true]) {
                assert.deepStrictEqual(
                    run(DreameMapParser.PARSE_PATH, header, trace, append),
                    run(referenceParsePath, header, trace, append),
                    String(trace)
                );
            }
        }
    });
});
