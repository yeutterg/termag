import { spawn, ChildProcess } from "node:child_process";

export type CaffeinateMode = "disabled" | "while-task" | "lid-closed" | "forever" | "timed";

export interface CaffeinateState {
  mode: CaffeinateMode;
  isActive: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
}

let caffeinateProcess: ChildProcess | null = null;
let currentState: CaffeinateState = {
  mode: "disabled",
  isActive: false,
  startTime: null,
  endTime: null,
  reason: null,
};
let caffeinateTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Start caffeinate with specified mode
 */
export function startCaffeinate(
  mode: CaffeinateMode,
  reason: string,
  durationMs?: number
): { success: boolean; error?: string } {
  // Stop any existing caffeinate
  if (caffeinateProcess) {
    stopCaffeinate();
  }

  // `-i` prevents idle system sleep without forcing the display awake. Screen
  // lock and display sleep therefore continue to work while terminals remain
  // reachable. Keep options before any utility; the previous leading
  // "caffeinate" accidentally made a second caffeinate process the utility.
  const args: string[] = ["-i"];

  // Add mode-specific arguments
  switch (mode) {
    case "while-task":
      args.push("-w", String(process.pid));
      break;
    case "lid-closed":
      // Retained as a protocol-v1 alias. macOS still sleeps when a laptop lid
      // is physically closed unless normal clamshell requirements are met.
      args.push("-w", String(process.pid));
      break;
    case "forever":
      // The owned child itself is the lifetime boundary.
      break;
    case "timed":
      if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) {
        return { success: false, error: "Duration required for timed mode" };
      }
      args.push("-t", Math.floor(durationMs / 1000).toString());
      break;
    case "disabled":
      return { success: false, error: "Cannot start caffeinate in disabled mode" };
  }

  try {
    const child = spawn("caffeinate", args, {
      detached: false,
      stdio: "ignore",
    });
    caffeinateProcess = child;

    // Handle process errors
    child.on("error", err => {
      console.error(`[caffeinate] Failed to start: ${err.message}`);
      if (caffeinateProcess === child) {
        caffeinateProcess = null;
        currentState.isActive = false;
        currentState.mode = "disabled";
      }
    });

    child.on("exit", (code, signal) => {
      console.log(`[caffeinate] Exited (code: ${code}, signal: ${signal})`);
      if (caffeinateProcess === child) {
        caffeinateProcess = null;
        currentState.isActive = false;
        currentState.mode = "disabled";
      }
    });

    // Update state
    currentState = {
      mode,
      isActive: true,
      startTime: new Date().toISOString(),
      endTime:
        mode === "timed" && durationMs ? new Date(Date.now() + durationMs).toISOString() : null,
      reason,
    };

    // Set timeout for timed mode
    if (mode === "timed" && durationMs) {
      caffeinateTimeout = setTimeout(() => {
        stopCaffeinate();
      }, durationMs);
    }

    console.log(`[caffeinate] Started in ${mode} mode (${reason})`);
    return { success: true };
  } catch (err) {
    const error = err as Error;
    return { success: false, error: error.message };
  }
}

/**
 * Stop caffeinate
 */
export function stopCaffeinate(): { success: boolean; error?: string } {
  if (caffeinateTimeout) {
    clearTimeout(caffeinateTimeout);
    caffeinateTimeout = null;
  }

  if (!caffeinateProcess) {
    return { success: true };
  }

  try {
    const child = caffeinateProcess;
    caffeinateProcess = null;
    child.kill("SIGTERM");
    // Wait a bit for graceful shutdown
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 1000).unref();

    currentState.isActive = false;
    currentState.mode = "disabled";
    currentState.startTime = null;
    currentState.endTime = null;

    console.log("[caffeinate] Stopped");
    return { success: true };
  } catch (err) {
    const error = err as Error;
    return { success: false, error: error.message };
  }
}

/**
 * Get current caffeinate state
 */
export function getCaffeinateState(): CaffeinateState {
  return { ...currentState };
}

/**
 * Check if caffeinate is currently active
 */
export function isCaffeinateActive(): boolean {
  return currentState.isActive;
}

/**
 * Clean up on shutdown
 */
export function cleanupCaffeinate() {
  if (caffeinateTimeout) {
    clearTimeout(caffeinateTimeout);
    caffeinateTimeout = null;
  }
  if (caffeinateProcess) {
    try {
      caffeinateProcess.kill("SIGTERM");
    } catch {
      // Ignore errors during shutdown
    }
    caffeinateProcess = null;
  }
}
