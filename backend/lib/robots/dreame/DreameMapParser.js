const DreameConst = require("./DreameConst");
const Logger = require("../../Logger");
const mapEntities = require("../../entities/map");
const uuid = require("uuid");
const zlib = require("zlib");

/**
 * P-Frames contain relative changes to the previous I- or even P-Frame
 *
 * That means that e.g. positions parsed from p-frames require the most recent previous absolute position to make sense
 */

class DreameMapParser {
    /**
     * This expects the already inflated buffer.
     * Since there are no magic bytes, there's no real way to do sanity checking which is sad.
     *
     * :(
     *
     * @param {Buffer} buf
     * @param {MapDataType} [mapType]
     * @param {Array<{type: string, metaData: any}>} [existingLayers] Only for a saved map (rism) that is going to be merged
     *                                                                into a map that already has these layers. Pixels are
     *                                                                not parsed for layers that wouldn't be used and
     *                                                                the result is no ValetudoMap but just its parts
     * @returns {Promise<null|any|import("../../entities/map/ValetudoMap")>}
     */
    static async PARSE(buf, mapType = MAP_DATA_TYPES.REGULAR, existingLayers = undefined) {
        //Maps are always at least 27 bytes in size
        if (!buf || buf.length < HEADER_SIZE) {
            return null;
        }

        const parsedHeader = DreameMapParser.PARSE_HEADER(buf.subarray(0, HEADER_SIZE));


        // Since P-Frame parsing is much harder than I-Frame parsing, we're skipping them
        if (parsedHeader.frame_type !== FRAME_TYPES.I) {
            return null;
        }

        const layers = [];
        const entities = [];
        const metaData = {};

        if (parsedHeader.robot_position.valid === true) {
            entities.push(
                new mapEntities.PointMapEntity({
                    points: [
                        parsedHeader.robot_position.x,
                        parsedHeader.robot_position.y
                    ],
                    metaData: {
                        angle: DreameMapParser.CONVERT_ANGLE_TO_VALETUDO(parsedHeader.robot_position.angle)
                    },
                    type: mapEntities.PointMapEntity.TYPE.ROBOT_POSITION
                })
            );
        }

        if (parsedHeader.charger_position.valid === true) {
            entities.push(
                new mapEntities.PointMapEntity({
                    points: [
                        parsedHeader.charger_position.x,
                        parsedHeader.charger_position.y
                    ],
                    metaData: {
                        angle: DreameMapParser.CONVERT_ANGLE_TO_VALETUDO(parsedHeader.charger_position.angle)
                    },
                    type: mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION
                })
            );
        }


        if (buf.length >= HEADER_SIZE + parsedHeader.width * parsedHeader.height) {
            const imageData = buf.subarray(HEADER_SIZE, HEADER_SIZE + parsedHeader.width * parsedHeader.height);
            const activeSegmentIds = [];
            const segmentNames = {};
            const segmentMaterials = {};
            let additionalData = {};

            try {
                additionalData = JSON.parse(buf.subarray(parsedHeader.width * parsedHeader.height + HEADER_SIZE).toString());
            } catch (e) {
                Logger.warn("Error while parsing additional map data", e);
            }

            if (additionalData.sa && Array.isArray(additionalData.sa)) {
                additionalData.sa.forEach(sa => {
                    activeSegmentIds.push(sa[0].toString());
                });
            }

            if (additionalData.curid !== undefined) {
                metaData.vendorMapId = parseInt(additionalData.curid);
            }

            if (additionalData.seg_inf) {
                Object.keys(additionalData.seg_inf).forEach(segmentId => {
                    if (additionalData.seg_inf[segmentId].name) {
                        segmentNames[segmentId] = Buffer.from(additionalData.seg_inf[segmentId].name, "base64").toString("utf8");
                    }

                    if (additionalData.seg_inf[segmentId].material !== undefined) {
                        let material;
                        switch (additionalData.seg_inf[segmentId].material) {
                            case 0:
                                material = mapEntities.MapLayer.MATERIAL.GENERIC;
                                break;
                            case 1:
                                material = mapEntities.MapLayer.MATERIAL.WOOD_HORIZONTAL;

                                if (additionalData.seg_inf[segmentId].direction === 90) {
                                    material = mapEntities.MapLayer.MATERIAL.WOOD_VERTICAL;
                                }

                                break;
                            case 2:
                                material = mapEntities.MapLayer.MATERIAL.TILE;
                                break;
                            case 5:
                                material = mapEntities.MapLayer.MATERIAL.CARPET_HIGH;
                                break;
                            case 6:
                                material = mapEntities.MapLayer.MATERIAL.CARPET_LOW;
                                break;
                            case 7:
                                material = mapEntities.MapLayer.MATERIAL.CARPET;
                                break;
                            default:
                                Logger.warn("Unhandled segment material", additionalData.seg_inf[segmentId].material);
                        }

                        segmentMaterials[segmentId] = material;
                    }
                });
            }

            layers.push(...DreameMapParser.PARSE_IMAGE(parsedHeader, activeSegmentIds, segmentNames, segmentMaterials, imageData, mapType, existingLayers));

            /**
             * Contains saved map data such as virtual restrictions as well as segments
             *
             * ris 2 seems to represent that the rism data shall be applied to the map while ris 1 only appears
             * after the robot complains about being unable to use the map
             *
             * With vSLAM robots, ris doesn't automatically switch from 1 to 2 after the initial cleanup.
             * Instead, it requires the start of another cleanup
             * Because of that, we also need to check for iscleanlog, so that a vSlam user gets to see their
             * newly mapped segments without any instantly aborted second cleanups.
             */
            if (additionalData.rism && (additionalData.ris === 2 || additionalData.iscleanlog === true)) {
                const rismResult = await DreameMapParser.PARSE(
                    await DreameMapParser.PREPROCESS(additionalData.rism),
                    MAP_DATA_TYPES.RISM,
                    layers
                );

                if (rismResult) {
                    rismResult.entities.forEach(e => {
                        if (e instanceof mapEntities.PointMapEntity) {
                            if (e.type === mapEntities.PointMapEntity.TYPE.ROBOT_POSITION && parsedHeader.robot_position.valid === false) {
                                entities.push(e);
                            }
                            if (e.type === mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION && parsedHeader.charger_position.valid === false) {
                                entities.push(e);
                            }
                        } else if (e instanceof mapEntities.PolygonMapEntity) {
                            if (
                                e.type === mapEntities.PolygonMapEntity.TYPE.NO_GO_AREA ||
                                e.type === mapEntities.PolygonMapEntity.TYPE.NO_MOP_AREA ||
                                e.type === mapEntities.PolygonMapEntity.TYPE.CARPET ||
                                e.type === mapEntities.PolygonMapEntity.TYPE.RAMP
                            ) {
                                entities.push(e);
                            }
                        } else if (e instanceof mapEntities.LineMapEntity) {
                            if (
                                e.type === mapEntities.LineMapEntity.TYPE.VIRTUAL_WALL ||
                                e.type === mapEntities.LineMapEntity.TYPE.THRESHOLD ||
                                e.type === mapEntities.LineMapEntity.TYPE.CURTAIN
                            ) {
                                entities.push(e);
                            }
                        }
                    });

                    rismResult.layers.forEach(l => {
                        if (l.metaData.segmentId !== undefined) {
                            if (activeSegmentIds.includes(l.metaData.segmentId)) { //required for the 1C
                                l.metaData.active = true;
                            }

                            if (layers.findIndex(eL => {
                                return eL.metaData.segmentId === l.metaData.segmentId;
                            }) === -1) {
                                layers.push(l);
                            } else {
                                if (l.metaData.name) {
                                    layers.find(eL => {
                                        return eL.metaData.segmentId === l.metaData.segmentId;
                                    }).metaData.name = l.metaData.name;
                                }
                                if (l.metaData.material) {
                                    layers.find(eL => {
                                        return eL.metaData.segmentId === l.metaData.segmentId;
                                    }).metaData.material = l.metaData.material;
                                }
                            }
                        } else {
                            if (layers.findIndex(eL => {
                                return eL.type === l.type;
                            }) === -1) {
                                layers.push(l);
                            }
                        }
                    });

                    if (rismResult.metaData?.dreamePendingMapChange !== undefined) {
                        metaData.dreamePendingMapChange = rismResult.metaData.dreamePendingMapChange;
                    }
                }
            }


            if (additionalData.tr) {
                const paths = DreameMapParser.PARSE_PATH(parsedHeader, additionalData.tr, additionalData.l2r === 1);

                if (paths?.length > 0) {
                    entities.push(...paths);
                }

            }

            if (Array.isArray(additionalData.da)) { //1C
                entities.push(
                    ...DreameMapParser.PARSE_AREAS(
                        parsedHeader,
                        [additionalData.da],
                        mapEntities.PolygonMapEntity.TYPE.ACTIVE_ZONE
                    )
                );
            }

            if (additionalData.da2 && Array.isArray(additionalData.da2.areas)) {
                entities.push(
                    ...DreameMapParser.PARSE_AREAS(
                        parsedHeader,
                        additionalData.da2.areas,
                        mapEntities.PolygonMapEntity.TYPE.ACTIVE_ZONE
                    )
                );
            }

            if (additionalData.vw) {
                if (Array.isArray(additionalData.vw.rect)) {
                    entities.push(
                        ...DreameMapParser.PARSE_AREAS(
                            parsedHeader,
                            additionalData.vw.rect,
                            mapEntities.PolygonMapEntity.TYPE.NO_GO_AREA
                        )
                    );
                }

                if (Array.isArray(additionalData.vw.mop)) {
                    entities.push(
                        ...DreameMapParser.PARSE_AREAS(
                            parsedHeader,
                            additionalData.vw.mop,
                            mapEntities.PolygonMapEntity.TYPE.NO_MOP_AREA
                        )
                    );
                }

                if (Array.isArray(additionalData.vw.line)) {
                    entities.push(
                        ...DreameMapParser.PARSE_LINES(
                            parsedHeader,
                            additionalData.vw.line,
                            mapEntities.LineMapEntity.TYPE.VIRTUAL_WALL
                        )
                    );
                }

                // Apparently there's also .cliff?
            }

            if (additionalData.vws) {
                if (Array.isArray(additionalData.vws.vwsl)) {
                    entities.push(
                        ...DreameMapParser.PARSE_LINES(
                            parsedHeader,
                            additionalData.vws.vwsl,
                            mapEntities.LineMapEntity.TYPE.THRESHOLD
                        )
                    );
                }

                if (Array.isArray(additionalData.vws.ramp)) {
                    entities.push(
                        ...DreameMapParser.PARSE_RAMPS(
                            parsedHeader,
                            additionalData.vws.ramp
                        )
                    );
                }
            }

            if (additionalData.ct) {
                if (Array.isArray(additionalData.ct.line)) {
                    entities.push(
                        ...DreameMapParser.PARSE_LINES(
                            parsedHeader,
                            additionalData.ct.line,
                            mapEntities.LineMapEntity.TYPE.CURTAIN
                        )
                    );
                }
            }

            /*
                rec_vw can be an object of recommendations by the robot firmware that may look like this:

                {
                    "vwsl":    [[x1, y1, x2, y2], ...],   // passable thresholds
                    "npthrsd": [[x1, y1, x2, y2], ...],   // impassable thresholds
                    "rect":    [[x1, y1, x2, y2], ...],   // no-go zones
                    "mop":     [[x1, y1, x2, y2], ...],   // no-mop zones
                    "line":    [[x1, y1, x2, y2], ...],   // virtual walls
                    "carpet":  [[x1, y1, x2, y2], ...]    // carpets
                }
             */

            /*
                TODO RESEARCH

                There can be an spoint object. No idea what that does
                There can also be multiple tpoint points. No idea when or why that happens or what it does either
             */
            if (additionalData.pointinfo && Array.isArray(additionalData.pointinfo.tpoint) && additionalData.pointinfo.tpoint.length === 1) {
                const goToPoint = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(
                    additionalData.pointinfo.tpoint[0][0],
                    additionalData.pointinfo.tpoint[0][1],
                );

                entities.push(new mapEntities.PointMapEntity({
                    points: [
                        goToPoint.x,
                        goToPoint.y,
                    ],
                    type: mapEntities.PointMapEntity.TYPE.GO_TO_TARGET
                }));
            }

            if (additionalData.suw > 0) {
                /*
                    6 = New Map in Single-map
                    5 = New Map in Multi-map

                    other values TBD
                 */
                metaData.dreamePendingMapChange = true;
            }

            if (additionalData.ai_obstacle?.length > 0) {
                additionalData.ai_obstacle.forEach((obstacle) => {
                    const coords = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(
                        parseFloat(obstacle[0]),
                        parseFloat(obstacle[1])
                    );
                    const type = DreameConst.AI_CLASSIFIER_IDS[obstacle[2]] ?? `Unknown ID ${obstacle[2]}`;
                    const confidence = `${Math.round(parseFloat(obstacle[3])*100)}%`;
                    const image = obstacle[5] !== undefined ? obstacle[5] : undefined;

                    if (HIDDEN_OBSTACLE_TYPES.includes(obstacle[2])) {
                        return;
                    }

                    entities.push(new mapEntities.PointMapEntity({
                        points: [
                            coords.x,
                            coords.y,
                        ],
                        type: mapEntities.PointMapEntity.TYPE.OBSTACLE,
                        metaData: {
                            label: `${type} (${confidence})`,
                            id: uuid.v5(
                                `${obstacle[2]}_${obstacle[0]}_${obstacle[1]}`,
                                OBSTACLE_ID_NAMESPACE
                            ),
                            image: image
                        }
                    }));
                });
            }

            if (additionalData.carpet_info) {
                for (const [carpetId, carpetInfo] of Object.entries(additionalData.carpet_info)) {
                    const pA = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(carpetInfo[0], carpetInfo[1]);
                    const pB = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(carpetInfo[2], carpetInfo[3]);

                    //I'm way too lazy to figure out which dreame model uses which order of coordinates
                    const xCoords = [pA.x, pB.x].sort((a, b) => {
                        return a-b;
                    });
                    const yCoords = [pA.y, pB.y].sort((a, b) => {
                        return a-b;
                    });

                    entities.push(new mapEntities.PolygonMapEntity({
                        points: [
                            xCoords[0], yCoords[0],
                            xCoords[1], yCoords[0],
                            xCoords[1], yCoords[1],
                            xCoords[0], yCoords[1]
                        ],
                        type: mapEntities.PolygonMapEntity.TYPE.CARPET,
                        metaData: {
                            id: carpetId
                        }
                    }));

                }
            }

            if (additionalData.carpet_polygon) {
                for (const [carpetId, carpetPolygon] of Object.entries(additionalData.carpet_polygon)) {
                    const coords = carpetPolygon[0];
                    const points = [];

                    for (let i = 0; i < coords.length; i = i + 2) {
                        const p = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(coords[i], coords[i+1]);

                        points.push(p.x, p.y);
                    }

                    entities.push(new mapEntities.PolygonMapEntity({
                        points: points,
                        type: mapEntities.PolygonMapEntity.TYPE.CARPET,
                        metaData: {
                            id: carpetId
                        }
                    }));

                }
            }

        } else {
            //Just a header
            return null;
        }

        // While the map is technically valid at this point, we still ignore it as we don't need a map with 0 pixels
        if (layers.length === 0) {
            return null;
        }

        if (existingLayers) {
            return {
                metaData: metaData,
                layers: layers,
                entities: entities
            };
        }

        return new mapEntities.ValetudoMap({
            metaData: metaData,
            size: {
                x: MAX_X,
                y: MAX_Y
            },
            pixelSize: parsedHeader.pixelSize,
            layers: layers,
            entities: entities
        });
    }

    static PARSE_HEADER(buf) {
        const parsedHeader = {
            robot_position: {},
            charger_position: {}
        };

        parsedHeader.id = buf.readInt16LE();
        parsedHeader.frame_id = buf.readInt16LE(2);
        parsedHeader.frame_type = buf.readInt8(4);

        parsedHeader.robot_position = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(buf.readInt16LE(5), buf.readInt16LE(7));
        parsedHeader.robot_position.angle = buf.readInt16LE(9);
        parsedHeader.robot_position.valid = true;

        parsedHeader.charger_position = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(buf.readInt16LE(11), buf.readInt16LE(13));
        parsedHeader.charger_position.angle = buf.readInt16LE(15);
        parsedHeader.charger_position.valid = true;

        parsedHeader.pixelSize = Math.round(buf.readInt16LE(17) / 10);

        parsedHeader.width = buf.readInt16LE(19);
        parsedHeader.height = buf.readInt16LE(21);

        parsedHeader.left = Math.round((buf.readInt16LE(23) + HALF_INT16 )/ 10);
        parsedHeader.top = Math.round((buf.readInt16LE(25) + HALF_INT16) / 10);


        if (buf.readInt16LE(5) === HALF_INT16_UPPER_HALF && buf.readInt16LE(7) === HALF_INT16_UPPER_HALF) {
            parsedHeader.robot_position.valid = false;
        }

        if (buf.readInt16LE(11) === HALF_INT16_UPPER_HALF && buf.readInt16LE(13) === HALF_INT16_UPPER_HALF) {
            parsedHeader.charger_position.valid = false;
        }

        return parsedHeader;
    }

    /**
     * This is called for every map update, so it is written to not allocate anything per pixel.
     * Pixels end up in their layers sorted by y first and x second (both ascending), which is what
     * MapLayer requires for its compression.
     *
     * @param {any} parsedHeader
     * @param {Array<string>} activeSegmentIds
     * @param {any} segmentNames
     * @param {any} segmentMaterials
     * @param {Buffer} buf
     * @param {MapDataType} mapType
     * @param {Array<{type: string, metaData: any}>} [existingLayers] If provided, layers that already exist there are not built
     *                                                                but only returned as {type, metaData}
     * @returns {Array<any>}
     */
    static PARSE_IMAGE(parsedHeader, activeSegmentIds, segmentNames, segmentMaterials, buf, mapType, existingLayers = undefined) {
        const layers = [];
        const width = parsedHeader.width;
        const height = parsedHeader.height;
        const categories = PIXEL_CATEGORIES[mapType];

        if (categories === undefined || !(width > 0 && height > 0)) {
            return layers;
        }

        if (buf.length < width * height) {
            buf = Buffer.concat([buf, Buffer.alloc(width * height - buf.length)]);
        }

        /**
         * The valetudo map origin is in the top left corner
         * The dreame map origin is in the bottom left corner
         *
         * Therefore, we need to flip this and every Y coordinate
         */
        const xCoordinates = new Array(width);
        const yCoordinates = new Array(height);

        for (let j = 0; j < width; j++) {
            xCoordinates[j] = Math.round(j + ((parsedHeader.left)/parsedHeader.pixelSize));
        }
        for (let i = 0; i < height; i++) {
            yCoordinates[i] = Math.round((MAX_Y / parsedHeader.pixelSize) - (i + ((parsedHeader.top)/parsedHeader.pixelSize)));
        }

        const pixelCounts = new Int32Array(PIXEL_CATEGORY_COUNT);

        for (let i = 0; i < width * height; i++) {
            pixelCounts[categories[buf[i]]]++;
        }

        if (
            pixelCounts.some((count, category) => {
                return category !== PIXEL_CATEGORY.NONE && count > 0;
            }) &&
            !(Number.isInteger(xCoordinates[0]) && Number.isInteger(yCoordinates[0]))
        ) {
            throw new Error("Only integer coordinates are allowed"); // Same as MapLayer
        }

        // The pixels of a layer of a saved map (rism) are of no use if the map it is merged into has that layer, too
        const isNeeded = (type, segmentId) => {
            return existingLayers === undefined || !existingLayers.some(l => {
                return segmentId === undefined ? l.type === type : l.metaData.segmentId === segmentId;
            });
        };
        const pixels = new Array(PIXEL_CATEGORY_COUNT);
        const writePositions = new Int32Array(PIXEL_CATEGORY_COUNT);
        let anyNeeded = false;

        pixelCounts.forEach((count, category) => {
            if (category !== PIXEL_CATEGORY.NONE && count > 0 && isNeeded(...DreameMapParser.GET_PIXEL_CATEGORY_LAYER(category))) {
                pixels[category] = new Int32Array(count * 2);
                anyNeeded = true;
            }
        });

        // Bottom to top, because the y coordinates are flipped
        for (let i = height - 1; anyNeeded && i >= 0; i--) {
            const y = yCoordinates[i];

            for (let j = 0; j < width; j++) {
                const category = categories[buf[(i * width) + j]];
                const categoryPixels = pixels[category];

                if (categoryPixels !== undefined) {
                    const position = writePositions[category];

                    categoryPixels[position] = xCoordinates[j];
                    categoryPixels[position + 1] = y;
                    writePositions[category] = position + 2;
                }
            }
        }

        pixelCounts.forEach((count, category) => {
            if (category === PIXEL_CATEGORY.NONE || count === 0) {
                return;
            }

            const [type, segmentId] = DreameMapParser.GET_PIXEL_CATEGORY_LAYER(category);
            const metaData = {};

            if (type === mapEntities.MapLayer.TYPE.SEGMENT) {
                metaData.segmentId = segmentId;
                metaData.active = activeSegmentIds.includes(segmentId);
                metaData.source = mapType;

                if (segmentNames[segmentId]) {
                    metaData.name = segmentNames[segmentId];
                }

                if (segmentMaterials[segmentId]) {
                    metaData.material = segmentMaterials[segmentId];
                }
            }

            layers.push(pixels[category] ?
                new mapEntities.MapLayer({pixels: pixels[category], type: type, metaData: metaData}) :
                {type: type, metaData: metaData}
            );
        });

        return layers;
    }

    /**
     * @param {number} category
     * @returns {[string, string|undefined]} type and segment id of the layer
     */
    static GET_PIXEL_CATEGORY_LAYER(category) {
        switch (category) {
            case PIXEL_CATEGORY.FLOOR:
                return [mapEntities.MapLayer.TYPE.FLOOR, undefined];
            case PIXEL_CATEGORY.WALL:
                return [mapEntities.MapLayer.TYPE.WALL, undefined];
            default:
                return [mapEntities.MapLayer.TYPE.SEGMENT, String(category - PIXEL_CATEGORY.FIRST_SEGMENT + 1)];
        }
    }

    /**
     * Parses the trace of the robot, which is "S<x>,<y>" followed by any number of "L<dx>,<dy>"
     * (and from time to time another start, because the robot moves without cleaning or switches to mopping).
     *
     * A trace can easily have thousands of points, so this is a hand-written scanner instead of a regex that
     * allocates a match object and several strings per point. Just like the regex it replaced, it skips everything
     * that isn't an operator followed by two comma separated integers.
     *
     * @param {any} parsedHeader
     * @param {string} traceString
     * @param {boolean} appendRobotPosition
     * @returns {Array<import("../../entities/map/entities/PathMapEntity")>}
     */
    static PARSE_PATH(parsedHeader, traceString, appendRobotPosition) {
        const trace = String(traceString);
        const paths = [];
        let currentPoints = undefined;
        let x = 0;
        let y = 0;
        let position = 0;

        while (position < trace.length) {
            const operator = trace.charCodeAt(position);

            if (PATH_OPERATOR_CODES.has(operator) && scanInteger(trace, position + 1)) {
                const xValue = scanned.value;
                const afterX = scanned.end;

                if (trace.charCodeAt(afterX) === CHAR_CODE.COMMA && scanInteger(trace, afterX + 1)) {
                    if (operator === PATH_OPERATORS.RELATIVE_LINE) {
                        x += xValue;
                        y += scanned.value;
                    } else {
                        currentPoints = [];
                        paths.push(currentPoints);

                        x = xValue;
                        y = scanned.value;
                    }

                    currentPoints.push(
                        Math.round((x + HALF_INT16)/10),
                        MAX_Y - Math.round((y + HALF_INT16)/10)
                    );
                    position = scanned.end;

                    continue;
                }
            }

            position++;
        }

        //Add the robot position to the last of all paths
        if (appendRobotPosition && paths.length > 0) {
            paths[paths.length - 1].push(parsedHeader.robot_position.x, parsedHeader.robot_position.y);
        }

        return paths.map(points => {
            return new mapEntities.PathMapEntity({
                points: points,
                type: mapEntities.PathMapEntity.TYPE.PATH
            });
        });
    }

    static PARSE_AREAS(parsedHeader, areas, type) {
        return areas.map(a => {
            const pA = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(a[0], a[1]);
            const pB = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(a[2], a[3]);

            //I'm way too lazy to figure out which dreame model uses which order of coordinates
            const xCoords = [pA.x, pB.x].sort((a, b) => {
                return a-b;
            });
            const yCoords = [pA.y, pB.y].sort((a, b) => {
                return a-b;
            });


            return new mapEntities.PolygonMapEntity({
                type: type,
                points: [
                    xCoords[0], yCoords[0],
                    xCoords[1], yCoords[0],
                    xCoords[1], yCoords[1],
                    xCoords[0], yCoords[1]
                ]
            });
        });
    }

    static PARSE_LINES(parsedHeader, lines, type) {
        return lines.map(a => {
            const pA = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(a[0], a[1]);
            const pB = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(a[2], a[3]);


            return new mapEntities.LineMapEntity({
                type: type,
                points: [pA.x,pA.y,pB.x,pB.y]
            });
        });
    }

    static PARSE_RAMPS(parsedHeader, ramps) {
        return ramps.map(r => {
            const pA = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(r[0], r[1]);
            const pB = DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(r[2], r[3]);
            const angle = r[4];

            const minX = Math.min(pA.x, pB.x);
            const minY = Math.min(pA.y, pB.y);
            const maxX = Math.max(pA.x, pB.x);
            const maxY = Math.max(pA.y, pB.y);

            const corners = [
                { x: minX, y: minY },
                { x: maxX, y: minY },
                { x: maxX, y: maxY },
                { x: minX, y: maxY }
            ];

            const centerX = (minX + maxX) / 2;
            const centerY = (minY + maxY) / 2;
            const angleRad = -angle * Math.PI / 180;

            const rotatedCorners = corners.map(point => {
                const translatedX = point.x - centerX;
                const translatedY = point.y - centerY;

                const rotatedX = translatedX * Math.cos(angleRad) - translatedY * Math.sin(angleRad);
                const rotatedY = translatedX * Math.sin(angleRad) + translatedY * Math.cos(angleRad);

                return {
                    x: Math.round(rotatedX + centerX),
                    y: Math.round(rotatedY + centerY)
                };
            });

            return new mapEntities.PolygonMapEntity({
                type: mapEntities.PolygonMapEntity.TYPE.RAMP,
                points: [
                    rotatedCorners[0].x, rotatedCorners[0].y,
                    rotatedCorners[1].x, rotatedCorners[1].y,
                    rotatedCorners[2].x, rotatedCorners[2].y,
                    rotatedCorners[3].x, rotatedCorners[3].y
                ]
            });
        });
    }

    /**
     * Uploaded dreame Maps are actually base64url strings of zlib compressed data
     *
     * https://tools.ietf.org/html/rfc4648#section-5
     *
     *
     *
     * @param {Buffer|string} data
     * @returns {Promise<Buffer|null>}
     */
    static async PREPROCESS(data) {
        // As string.toString() is a no-op, we don't need to check the type beforehand
        const base64String = data.toString().replace(/_/g, "/").replace(/-/g, "+");

        try {
            // intentional return await
            return await new Promise((resolve, reject) => {
                zlib.inflate(Buffer.from(base64String, "base64"), (err, result) => {
                    if (!err) {
                        resolve(result);
                    } else {
                        reject(err);
                    }
                });
            });
        } catch (e) {
            Logger.error("Error while preprocessing map", e);

            return null;
        }
    }
}

const PIXEL_TYPES = Object.freeze({
    NONE: 0,
    FLOOR: 1,
    WALL: 2,
    CARPET: 3
});

const FRAME_TYPES = Object.freeze({
    I: 73,
    P: 80
});

const PATH_OPERATORS = Object.freeze({
    START: "S".charCodeAt(0),
    MOP_START: "M".charCodeAt(0),
    DUAL_START: "W".charCodeAt(0),
    RELATIVE_LINE: "L".charCodeAt(0)
});
const PATH_OPERATOR_CODES = new Set(Object.values(PATH_OPERATORS));
const CHAR_CODE = Object.freeze({
    COMMA: ",".charCodeAt(0),
    MINUS: "-".charCodeAt(0),
    ZERO: "0".charCodeAt(0)
});
// Up to this many decimal digits can be summed up exactly
const MAX_EXACT_DIGITS = 15;

/**
 * The result of scanInteger. Being a shared object, it saves allocating one for each of the numbers of a trace.
 * This is fine, as scanning is synchronous
 */
const scanned = {value: 0, end: 0};

/**
 * Scans an integer like /-?\d+/y would match, but without allocating anything
 *
 * @param {string} text
 * @param {number} start
 * @returns {boolean} true if there is an integer at start. If so, it and the index after it are in `scanned`
 */
function scanInteger(text, start) {
    let index = start;
    let negative = false;
    let value = 0;

    if (text.charCodeAt(index) === CHAR_CODE.MINUS) {
        negative = true;
        index++;
    }

    const digitsStart = index;

    while (index < text.length) {
        const digit = text.charCodeAt(index) - CHAR_CODE.ZERO;

        if (digit < 0 || digit > 9) {
            break;
        }

        value = value * 10 + digit;
        index++;
    }

    if (index === digitsStart) {
        return false;
    }

    if (index - digitsStart > MAX_EXACT_DIGITS) {
        value = Number(text.slice(digitsStart, index));
    }

    scanned.value = negative ? -value : value;
    scanned.end = index;

    return true;
}

/**
 *  @typedef {string} MapDataType
 *  @enum {string}
 *
 */
const MAP_DATA_TYPES = Object.freeze({
    REGULAR: "regular",
    RISM: "rism" //Room-information Saved Map
});

/**
 * Every possible value of a pixel byte mapped to what it represents, so that parsing an image is a single table lookup
 * per pixel.
 *
 * A regular pixel is one byte consisting of
 *      000000               00
 *      The segment ID       The Type
 *
 * A rism pixel is one byte consisting of
 *      1            1                000000
 *      isWall flag  isCarpet flag    The Segment ID
 *
 * TODO: figure out what to do with the rism carpet information
 */
const PIXEL_CATEGORY = Object.freeze({
    NONE: 0,
    FLOOR: 1,
    WALL: 2,
    FIRST_SEGMENT: 3 // Segment 1. The ids go up to 63
});
const PIXEL_CATEGORY_COUNT = PIXEL_CATEGORY.FIRST_SEGMENT + 63;
const PIXEL_CATEGORIES = {
    [MAP_DATA_TYPES.REGULAR]: new Uint8Array(256).map((_, px) => {
        const segmentId = px >> 2;

        if (segmentId > 0 && segmentId < 62) { //62 is newly discovered floor
            return PIXEL_CATEGORY.FIRST_SEGMENT + segmentId - 1;
        }

        switch (px & 0b00000011) {
            case PIXEL_TYPES.FLOOR:
            case PIXEL_TYPES.CARPET:
                return PIXEL_CATEGORY.FLOOR;
            case PIXEL_TYPES.WALL:
                return PIXEL_CATEGORY.WALL;
            default:
                return PIXEL_CATEGORY.NONE;
        }
    }),
    [MAP_DATA_TYPES.RISM]: new Uint8Array(256).map((_, px) => {
        const segmentId = px & 0b00111111;

        if (px >> 7) {
            return PIXEL_CATEGORY.WALL;
        }

        return segmentId > 0 ? PIXEL_CATEGORY.FIRST_SEGMENT + segmentId - 1 : PIXEL_CATEGORY.NONE;
    })
};

const HALF_INT16 = 32768;
const HALF_INT16_UPPER_HALF = 32767;
const HEADER_SIZE = 27;
const MAX_X = Math.round(((HALF_INT16 + HALF_INT16_UPPER_HALF)/10));
const MAX_Y = Math.round(((HALF_INT16 + HALF_INT16_UPPER_HALF)/10));

DreameMapParser.HALF_INT16 = HALF_INT16;

/**
 * Dreame coordinates are signed INT16. Valetudo coordinates are unsigned
 * Therefore, every absolute position needs to be shifted by half an INT16
 *
 * The valetudo map origin is in the top left corner
 * The dreame map origin is in the bottom left corner
 *
 * Therefore, we need to flip this and every Y coordinate
 *
 *
 * @param {number} x
 * @param {number} y
 * @returns {{x: number, y: number}}
 */
DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES = function(x, y) {
    return {
        x: Math.round((x + HALF_INT16)/10),
        y: MAX_Y - Math.round((y + HALF_INT16)/10)
    };
};

/**
 *
 * @param {number} x
 * @param {number} y
 * @returns {{x: number, y: number}}
 */
DreameMapParser.CONVERT_TO_DREAME_COORDINATES = function(x, y) {
    return {
        x: (x*10) - HALF_INT16,
        y: (-1 * HALF_INT16) - ((y - MAX_Y) * 10) //thanks denna!
    };
};

/**
 * @param {number} angle
 * @return {number}
 */
DreameMapParser.CONVERT_ANGLE_TO_VALETUDO = function(angle) {
    //This flips the angle at the Y-axis due to our different coordinate system and then substracts 90° from it
    return ((angle < 180 ? 180 - angle : 360 - angle + 180) + 270) % 360;
};

const HIDDEN_OBSTACLE_TYPES = ["200", "204"];
const OBSTACLE_ID_NAMESPACE = "f90e13dc-3728-4267-bd90-43caa3f460e5";

module.exports = DreameMapParser;
