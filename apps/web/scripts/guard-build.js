const fs = require("node:fs");
const path = require("node:path");

const pidFiles = [
  path.join(__dirname, "..", ".terminalz-server.json"),
  path.join(__dirname, "..", ".termag-server.json"),
];

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

if (
  process.env.TERMINALZ_ALLOW_BUILD_WITH_SERVER === "true" ||
  process.env.TERMAG_ALLOW_BUILD_WITH_SERVER === "true"
) {
  process.exit(0);
}

let info = null;
let activePidFile = null;
for (const pidFile of pidFiles) {
  try {
    info = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    activePidFile = pidFile;
    break;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[terminalz] Ignoring unreadable server pid file: ${err.message}`);
    }
  }
}

if (info && isAlive(info.pid)) {
  console.error(
    [
      "[terminalz] Refusing to run next build while the Terminalz server is running.",
      `Active server pid: ${info.pid}${info.port ? ` on port ${info.port}` : ""}.`,
      "Stop the local preview server first, then rerun the build.",
      "Set TERMINALZ_ALLOW_BUILD_WITH_SERVER=true only if you intentionally want to override this guard.",
    ].join("\n")
  );
  process.exit(1);
}

if (info && activePidFile) {
  fs.rmSync(activePidFile, { force: true });
}
