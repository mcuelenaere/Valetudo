const Ajv = require("ajv");
const assert = require("node:assert");
const { describe, it } = require("node:test");

const entities = require("../../../lib/entities");
const SCHEMAS = require("../../../lib/doc/Configuration.openapi.json");
const ValetudoRobot = require("../../../lib/core/ValetudoRobot");

function createRobot(robotConfig, flags = {}) {
    const robot = new ValetudoRobot({
        config: {
            get: (key) => {
                return key === "robot" ? robotConfig : false;
            }
        },
        valetudoEventStore: {}
    });

    Object.assign(robot.flags, flags);

    return robot;
}

function setStatus(robot, value) {
    robot.state.upsertFirstMatchingAttribute(new entities.state.attributes.StatusStateAttribute({value: value}));
}

describe("ValetudoRobot map polling interval", () => {
    const robotConfig = {implementation: "auto", implementationSpecificConfig: {}};

    it("is unchanged without a configured interval", () => {
        const robot = createRobot(robotConfig);

        setStatus(robot, "docked");
        assert.strictEqual(robot.determineNextMapPollInterval(), 60);

        setStatus(robot, "cleaning");
        assert.strictEqual(robot.determineNextMapPollInterval(), 2);

        robot.flags.hugeMap = true;
        assert.strictEqual(robot.determineNextMapPollInterval(), 4);

        robot.flags.lowmemHost = true;
        assert.strictEqual(robot.determineNextMapPollInterval(), 8);

        // The polls after having become inactive are as slow as the active ones
        setStatus(robot, "docked");
        assert.strictEqual(robot.determineNextMapPollInterval(), 8);
    });

    it("uses the configured interval as it is while active, but only then", () => {
        const robot = createRobot({...robotConfig, activeMapPollIntervalSeconds: 10}, {hugeMap: true, lowmemHost: true});

        setStatus(robot, "docked");
        assert.strictEqual(robot.determineNextMapPollInterval(), 60);

        setStatus(robot, "returning");
        assert.strictEqual(robot.determineNextMapPollInterval(), 10);

        setStatus(robot, "docked");
        assert.strictEqual(robot.determineNextMapPollInterval(), 10);
    });

    it("ignores nonsensical configured intervals", () => {
        for (const value of [0, -1, NaN, "5", null, {}]) {
            const robot = createRobot({...robotConfig, activeMapPollIntervalSeconds: value});

            setStatus(robot, "cleaning");
            assert.strictEqual(robot.determineNextMapPollInterval(), 2, String(value));
        }
    });

    it("is validated as part of the configuration", () => {
        const ajv = new Ajv({removeAdditional: true});

        Object.keys(SCHEMAS.components.schemas).forEach(schemaName => {
            ajv.addSchema(SCHEMAS.components.schemas[schemaName], "#/components/schemas/" + schemaName);
        });

        const isValid = (activeMapPollIntervalSeconds) => {
            return ajv.validate(
                SCHEMAS.components.schemas.Configuration,
                {robot: {implementation: "auto", activeMapPollIntervalSeconds: activeMapPollIntervalSeconds}}
            );
        };

        assert.strictEqual(isValid(undefined), true);
        assert.strictEqual(isValid(1), true);
        assert.strictEqual(isValid(600), true);
        assert.strictEqual(isValid(0), false);
        assert.strictEqual(isValid(601), false);
        assert.strictEqual(isValid(2.5), false);
        assert.strictEqual(isValid("10"), false);
    });
});
