const fs = require("node:fs");
const path = require("node:path");
const cps = require("node:child_process");
const chalk = require("chalk");

const THROTTLE_TIME = 1000;
let throttleTimer = null;
let changedFiles = new Set();
let running = false;

const rootPath = process.cwd();
const contractsPath = path.resolve("contracts");

const messageMap = new Map();

function executeSolhint(all = false) {
    throttleTimer = null;
    if (running) return;
    running = true;
    const fileList = Array.from(changedFiles).filter(fname => fs.existsSync(fname));
    changedFiles.clear();
    // header
    console.log();
    console.log("Changes detected, executing solhint...");
    prepareMessageMap(messageMap, fileList);
    //
    const startTime = Date.now();
    let outputText = "";
    const filesArg = all ? `"contracts/**/*.sol"` : fileList.join(" ");
    const solhint = cps.spawn(`solhint ${filesArg} --formatter json --disc`, {
        shell: true,
        stdio: "pipe"
    });
    solhint.stdout.on("data", (data) => {
        outputText += data;
    });
    solhint.on("close", () => {
        running = false;
        // reformat output messages
        let data = parseJsonOutput(outputText);
        for (const line of data) {
            updateMessageMap(messageMap, line.filePath, line);
        }
        const duration = (Date.now() - startTime) / 1000;
        printMessages(messageMap, duration);
        // more file may have changed during run
        if (changedFiles.size > 0) {
            executeSolhint(false);
        }
    });
}

function prepareMessageMap(messageMap, fileList) {
    for (const fname of fileList) {
        messageMap.delete(fname);
    }
}

function parseJsonOutput(outputText) {
    try {
        return JSON.parse(outputText);
    } catch (e) {
        console.error(e);
        return [];
    }
}

function updateMessageMap(messageMap, filename, line) {
    if (filename) {
        if (!messageMap.get(filename)) {
            messageMap.set(filename, []);
        }
        messageMap.get(filename).push(line);
    }
}

function printMessages(messageMap, duration) {
    let warningCount = 0, errorCount = 0;
    for (const fileLines of messageMap.values()) {
        for (const line of fileLines) {
            const severity = line.severity?.toLowerCase();
            const severityColor = severity === "error" ? chalk.redBright : chalk.yellow;
            const positionInfo = `${chalk.cyanBright(line.filePath)}:${chalk.yellowBright(line.line)}:${chalk.yellowBright(line.column)}`;
            console.log(`${positionInfo} - ${severityColor(severity)} ${chalk.grey(line.ruleId + ":")} ${line.message}`);
            if (severity === "error") errorCount++; else warningCount++;
        }
    }
    console.log();
    console.log(`Solhint completed in ${duration}s. Found ${errorCount + warningCount} problems (${errorCount} errors, ${warningCount} warnings).`);
}

function runThrottled(method, throttleTime = THROTTLE_TIME) {
    if (throttleTimer != null) clearTimeout(throttleTimer);
    throttleTimer = setTimeout(method, throttleTime);
}

// main

if (!fs.existsSync("cache")) fs.mkdirSync("cache");
fs.rmSync("cache/solhint-cache.json", { force: true });

executeSolhint(true);

fs.watch(contractsPath, { recursive: true }, (event, fname) => {
    if (fname) {
        const relname = path.relative(rootPath, path.resolve(contractsPath, fname)).replaceAll("\\", "/");
        changedFiles.add(relname);
    }
    runThrottled(() => executeSolhint(false));
});
