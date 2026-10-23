const childProcess = require("child_process");
const fs = require('fs');
const path = require("path");


function GET_VALETUDO_VERSION() {
    let valetudoVersion = "unknown";

    try {
        const rootDirectory = path.resolve(__dirname, "..");
        const packageContent = fs.readFileSync(rootDirectory + "/package.json", {"encoding": "utf-8"});

        if (packageContent) {
            valetudoVersion = JSON.parse(packageContent.toString()).version;
        }
    } catch (e) {
        //intentional
    }

    return valetudoVersion;
}

function GET_COMMIT_ID() {
    let commitId = "unknown";

    try {
        const rootDirectory = path.resolve(__dirname, "..");

        // Works for worktrees and branches other than master, where reading .git/HEAD doesn't
        return childProcess.execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: rootDirectory,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"]
        }).trim();
    } catch (e) {
        //intentional
    }

    try {
        const rootDirectory = path.resolve(__dirname, "..");
        commitId = fs.readFileSync(rootDirectory + "/.git/HEAD", {"encoding": "utf-8"}).trim();

        if (commitId.match(/^ref: refs\/heads\/master$/) !== null) {
            commitId = fs.readFileSync(rootDirectory + "/.git/refs/heads/master", {"encoding": "utf-8"}).trim();
        }
    } catch (e) {
        //intentional
    }

    return commitId;
}


const metadata = {
    version: GET_VALETUDO_VERSION(),
    commit:  GET_COMMIT_ID(),
    buildTimestamp: new Date().toISOString(),
};

fs.writeFileSync(
    path.join(__dirname, "../backend/lib/res/build_metadata.json"),
    JSON.stringify(metadata)
);
