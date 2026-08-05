const fs = require("node:fs");
const path = require("node:path");

const pidFile = path.join(__dirname, "..", ".termag-server.json");

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

if (process.env.TERMAG_ALLOW_BUILD_WITH_SERVER === "true") {
  process.exit(0);
}

let info = null;
try {
  info = JSON.parse(fs.readFileSync(pidFile, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") {
    console.warn(`[termag] Ignoring unreadable server pid file: ${err.message}`);
  }
}

if (info && isAlive(info.pid)) {
  console.error(
    [
      "[termag] Refusing to run next build while the Termag server is running.",
      `Active server pid: ${info.pid}${info.port ? ` on port ${info.port}` : ""}.`,
      "Stop the local preview server first, then rerun the build.",
      "Set TERMAG_ALLOW_BUILD_WITH_SERVER=true only if you intentionally want to override this guard.",
    ].join("\n")
  );
  process.exit(1);
}

if (info) {
  fs.rmSync(pidFile, { force: true });
}
