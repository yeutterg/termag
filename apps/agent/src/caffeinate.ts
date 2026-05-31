import { spawn, ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";

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

  const args: string[] = ["caffeinate", "-d", "-u", "-s"]; // Prevent system sleep, display sleep, disk sleep

  // Add mode-specific arguments
  switch (mode) {
    case "while-task":
      // Default behavior - caffeinate until process ends
      break;
    case "lid-closed":
      args.push("-i"); // Prevent idle sleep even with lid closed
      break;
    case "forever":
      args.push("-w", "caffeinate"); // Wait for caffeinate command itself (never exits)
      break;
    case "timed":
      if (!durationMs) {
        return { success: false, error: "Duration required for timed mode" };
      }
      args.push("-t", Math.floor(durationMs / 1000).toString());
      break;
    case "disabled":
      return { success: false, error: "Cannot start caffeinate in disabled mode" };
  }

  try {
    caffeinateProcess = spawn("caffeinate", args, {
      detached: false,
      stdio: "ignore",
    });

    // Handle process errors
    caffeinateProcess.on("error", err => {
      console.error(`[caffeinate] Failed to start: ${err.message}`);
      caffeinateProcess = null;
      currentState.isActive = false;
      currentState.mode = "disabled";
    });

    caffeinateProcess.on("exit", (code, signal) => {
      console.log(`[caffeinate] Exited (code: ${code}, signal: ${signal})`);
      caffeinateProcess = null;
      currentState.isActive = false;
      if (mode === "timed") {
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
    caffeinateProcess.kill("SIGTERM");
    // Wait a bit for graceful shutdown
    setTimeout(() => {
      if (caffeinateProcess && !caffeinateProcess.killed) {
        caffeinateProcess.kill("SIGKILL");
      }
      caffeinateProcess = null;
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
