const assert = require("node:assert");
const EventEmitter = require("events").EventEmitter;
const { describe, it } = require("node:test");

const RobotRouter = require("../../../lib/webserver/RobotRouter");
const ValetudoRobot = require("../../../lib/core/ValetudoRobot");

function createRobot() {
    const emitter = new EventEmitter();
    let serializations = 0;
    const robot = {
        capabilities: {},
        state: {
            attributes: [{__class: "BatteryStateAttribute", level: 50}],
            map: {
                toJSON: () => {
                    serializations++;

                    return {__class: "ValetudoMap"};
                }
            },
            toJSON: function() {
                return {attributes: this.attributes, map: this.map};
            }
        },
        onStateUpdated: (listener) => {
            emitter.on(ValetudoRobot.EVENTS.StateUpdated, listener);
        },
        onStateAttributesUpdated: (listener) => {
            emitter.on(ValetudoRobot.EVENTS.StateAttributesUpdated, listener);
        },
        onMapUpdated: (listener) => {
            emitter.on(ValetudoRobot.EVENTS.MapUpdated, listener);
        }
    };

    return {
        robot: robot,
        emitter: emitter,
        serializations: () => {
            return serializations;
        }
    };
}

describe("RobotRouter SSE", () => {
    it("doesn't serialize the state and the map if nobody is listening", () => {
        const {robot, emitter, serializations} = createRobot();

        const router = new RobotRouter({robot: robot, validator: {}});

        emitter.emit(ValetudoRobot.EVENTS.StateUpdated);
        emitter.emit(ValetudoRobot.EVENTS.StateAttributesUpdated);
        emitter.emit(ValetudoRobot.EVENTS.MapUpdated);

        assert.strictEqual(serializations(), 0);
        assert.strictEqual(router.sseHubs.map.hasClients(), false);
    });

    it("sends the same events as before to the clients", () => {
        const {robot, emitter} = createRobot();
        const router = new RobotRouter({robot: robot, validator: {}});
        const received = {state: [], attributes: [], map: []};

        for (const hub of Object.keys(received)) {
            router.sseHubs[hub].register({write: (data) => {
                received[hub].push(data);
            }});
        }

        emitter.emit(ValetudoRobot.EVENTS.StateUpdated);
        emitter.emit(ValetudoRobot.EVENTS.StateAttributesUpdated);
        emitter.emit(ValetudoRobot.EVENTS.MapUpdated);

        assert.deepStrictEqual(received, {
            state: [`event: StateUpdated\ndata: ${JSON.stringify(robot.state)}\n\n`],
            attributes: [`event: StateAttributesUpdated\ndata: ${JSON.stringify(robot.state.attributes)}\n\n`],
            map: [`event: MapUpdated\ndata: ${JSON.stringify(robot.state.map)}\n\n`]
        });
    });
});
