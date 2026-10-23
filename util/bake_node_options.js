/*
    Copies a pkg base node binary (build_dependencies/pkg/v3.5/built-*) and bakes V8/node options into it
    in the same way pkg does for its --options flag.

    The pkg node binaries ignore their command line (the first argument is always the script) as well as NODE_OPTIONS,
    so this is the only way to run them with e.g. the options Valetudo is built with:

        node util/bake_node_options.js build_dependencies/pkg/v3.5/built-v22.17.1-linuxstatic-arm64 ./node-robot expose-gc max-heap-size=64
 */

const fs = require("fs");

const [input, output, ...options] = process.argv.slice(2);

if (!input || !output || options.length === 0) {
    throw new Error("Usage: bake_node_options.js <pkg base node> <output> <option>... (without leading dashes)");
}

const binary = fs.readFileSync(input);
const placeholder = Buffer.from(`\0${"// BAKERY ".repeat(20)}`);
let position = binary.indexOf(placeholder);

// Same as pkg: ignore the occurrence in the source code literal
while (position > 0 && binary[position - 1] === 39 /* ' */) {
    position = binary.indexOf(placeholder, position + 1);
}

if (position < 0) {
    throw new Error("BAKERY placeholder not found. Is this really a pkg base binary?");
}

// "--option\0--option\0\0", padded with \0 to the size of the placeholder. The first byte of it belongs to the placeholder, too
const value = Buffer.concat([...options.map(o => {
    return Buffer.from(`--${o}\0`);
}), Buffer.alloc(1)]);

if (value.length > placeholder.length) {
    throw new Error(`Too many options. At most ${placeholder.length} bytes are available`);
}

binary.fill(0, position, position + placeholder.length);
value.copy(binary, position);

fs.writeFileSync(output, binary, {mode: 0o755});
