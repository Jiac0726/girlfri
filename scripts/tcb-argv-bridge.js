const fs = require("fs");
const { spawnSync } = require("child_process");

const cliPath = process.argv[2];
const argsFile = process.argv[3];

if (!cliPath || !argsFile) {
  process.stderr.write("Usage: node tcb-argv-bridge.js <cli-js> <args-json-file>\n");
  process.exit(64);
}

const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
if (!Array.isArray(args) || !args.every((x) => typeof x === "string")) {
  process.stderr.write("Argument file must contain a JSON string array.\n");
  process.exit(65);
}

const result = spawnSync(process.execPath, [cliPath, ...args], {
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  process.stderr.write(String(result.error.stack || result.error) + "\n");
  process.exit(66);
}

process.exit(result.status == null ? 1 : result.status);
