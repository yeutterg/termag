/**
 * Command execution integration layer
 * Connects the command palette systems to the termag WebSocket/agent architecture
 */

import { prisma } from "./prisma";
import { executeCommandOnDevice } from "./broker";

export interface CommandExecutionOptions {
  sessionId: string;
  command: string;
  workingDirectory?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  output: string;
  exitCode: number;
  executedAt: string;
}

/**
 * Execute a command in the terminal via the agent
 */
export async function executeCommand(options: CommandExecutionOptions): Promise<CommandResult> {
  try {
    // Resolve sessionId to get project info
    const session = await prisma.session.findUnique({
      where: { id: options.sessionId },
      include: {
        tab: {
          include: {
            project: true,
          },
        },
      },
    });

    if (!session) {
      throw new Error("Session not found");
    }

    const userId = session.tab.project.userId;
    const deviceName = session.tab.project.rootKey;
    const workingDirectory = options.workingDirectory;

    // Execute command through the broker
    const result = await executeCommandOnDevice(
      userId,
      deviceName,
      options.command,
      workingDirectory,
      options.timeoutMs
    );

    return {
      output: result.output,
      exitCode: result.exitCode,
      executedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error("Failed to execute command:", error);
    throw error;
  }
}

/**
 * Execute git command
 */
export async function executeGitCommand(
  command: string,
  sessionId: string,
  workingDirectory?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await executeCommand({
    sessionId,
    command,
    workingDirectory,
  });

  // Split stdout and stderr (simple implementation)
  const parts = result.output.split("\n");
  const stdout = parts.join("\n");
  const stderr = "";

  return {
    stdout,
    stderr,
    exitCode: result.exitCode,
  };
}

/**
 * Read file content via agent
 */
export async function readFile(
  filePath: string,
  sessionId: string,
  workingDirectory?: string
): Promise<string> {
  const result = await executeCommand({
    sessionId,
    command: `cat "${filePath}"`,
    workingDirectory,
  });

  return result.output;
}

/**
 * Write file content via agent
 */
export async function writeFile(
  filePath: string,
  content: string,
  sessionId: string,
  workingDirectory?: string
): Promise<boolean> {
  const result = await executeCommand({
    sessionId,
    command: `cat > "${filePath}" << 'EOF'\n${content}\nEOF`,
    workingDirectory,
  });

  return result.exitCode === 0;
}

/**
 * List directory contents via agent
 */
export async function listDirectory(
  path: string,
  sessionId: string,
  workingDirectory?: string
): Promise<string[]> {
  const result = await executeCommand({
    sessionId,
    command: `ls -la "${path}"`,
    workingDirectory,
  });

  return result.output.split("\n").filter(line => line.trim());
}
