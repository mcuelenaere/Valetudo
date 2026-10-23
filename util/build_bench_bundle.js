/*
    Writes ./bench: util/bench_map_pipeline.js plus exactly the files it loads (found by running it once),
    in the same directory layout as the repository. The result only needs a node binary to run:

        ./node ./bench/bench_map_pipeline.js --json > result.json

    The cases for the map of a real robot (x40_*) are only part of it if there is such a map, see --x40-map
    in util/bench_map_pipeline.js. It is copied into the bundle, so keep the bundle to yourself in that case.
 */

const fs = require("fs");
const path = require("path");

const bench = require("./bench_map_pipeline");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "bench");

function copy(file) {
    const target = path.join(out, path.relative(root, file));

    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(file, target);
}

bench.run({quick: true}).then(() => {
    fs.rmSync(out, {recursive: true, force: true});

    const files = new Set([
        // read at runtime instead of required
        path.join(root, "backend/lib/res/valetudo_home_assistant_mqtt_wrapper.png"),
        ...fs.readdirSync(path.join(root, "backend/test/lib/robots/dreame/res/map")).filter(f => {
            return f.endsWith(".bin");
        }).map(f => {
            return path.join(root, "backend/test/lib/robots/dreame/res/map", f);
        })
    ]);

    for (const file of Object.keys(require.cache)) {
        if (file.startsWith(root + path.sep) && file !== __filename) {
            files.add(file);

            // The package.json files that define how node treats a dependency
            for (let dir = path.dirname(file); dir.includes(`${path.sep}node_modules${path.sep}`); dir = path.dirname(dir)) {
                if (fs.existsSync(path.join(dir, "package.json"))) {
                    files.add(path.join(dir, "package.json"));
                }
            }
        }
    }

    files.forEach(copy);

    const x40Map = bench.getX40MapFile();

    if (fs.existsSync(x40Map)) {
        // Where the bundled benchmark looks for it by default
        fs.mkdirSync(path.join(out, "util/res"), {recursive: true});
        fs.copyFileSync(x40Map, path.join(out, "util/res/bench_map_x40.json"));
        files.add(x40Map);
    } else {
        process.stdout.write(`There is no map at ${x40Map}, so the bundle doesn't have the x40_* cases\n`);
    }

    fs.writeFileSync(
        path.join(out, "bench_map_pipeline.js"),
        "require(\"./util/bench_map_pipeline.js\").main(process.argv.slice(2));\n"
    );

    process.stdout.write(`Wrote ${files.size + 1} files to ${out}\n`);
}).catch(err => {
    process.stderr.write(`${err.stack ?? err}\n`);
    process.exitCode = 1;
});
