/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { executeGitCommand as execGitCommand } from "./command-execution";

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

const GIT_STATUS_KEY = "termag-git-status";

/**
 * Execute git command in terminal
 */
export async function executeGitCommand(
  command: string,
  workingDirectory: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // This would integrate with the actual terminal/agent
  // For now, return a mock response
  console.log(`Executing git command in ${workingDirectory}: ${command}`);

  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
  };
}

/**
 * Get git status
 */
export async function getGitStatus(workingDirectory: string): Promise<GitStatus> {
  const result = await executeGitCommand("git status --porcelain", workingDirectory);

  // Parse git status output
  const status: GitStatus = {
    branch: "main",
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };

  // Parse output and populate status
  // This is a simplified parser - real implementation would parse actual git output
  const lines = result.stdout.split("\n");
  lines.forEach(line => {
    if (line.startsWith("M ")) {
      status.staged.push(line.slice(2));
    } else if (line.startsWith(" M")) {
      status.unstaged.push(line.slice(2));
    } else if (line.startsWith("??")) {
      status.untracked.push(line.slice(3));
    } else if (line.startsWith("UU")) {
      status.conflicted.push(line.slice(3));
    }
  });

  return status;
}

/**
 * Get git branches
 */
export async function getGitBranches(workingDirectory: string): Promise<GitBranch[]> {
  const result = await executeGitCommand("git branch -a", workingDirectory);

  const branches: GitBranch[] = [];
  const lines = result.stdout.split("\n");

  lines.forEach(line => {
    const isCurrent = line.startsWith("*");
    const name = line.replace(/^\*\s*/, "").trim();
    const isRemote = name.startsWith("remotes/");

    branches.push({
      name: isRemote ? name.replace("remotes/", "") : name,
      isCurrent,
      isRemote,
    });
  });

  return branches;
}

/**
 * Get git log
 */
export async function getGitLog(
  workingDirectory: string,
  limit: number = 10
): Promise<GitCommit[]> {
  const result = await executeGitCommand(
    `git log -${limit} --pretty=format:"%H|%s|%an|%ad" --date=iso`,
    workingDirectory
  );

  const commits: GitCommit[] = [];
  const lines = result.stdout.split("\n");

  lines.forEach(line => {
    const [hash, message, author, date] = line.split("|");
    if (hash) {
      commits.push({
        hash: hash.substring(0, 8),
        message,
        author,
        date,
      });
    }
  });

  return commits;
}

/**
 * Git commit
 */
export async function gitCommit(message: string, workingDirectory: string): Promise<boolean> {
  const result = await executeGitCommand(`git commit -m "${message}"`, workingDirectory);
  return result.exitCode === 0;
}

/**
 * Git push
 */
export async function gitPush(branch?: string, workingDirectory: string): Promise<boolean> {
  const command = branch ? `git push origin ${branch}` : "git push";
  const result = await executeGitCommand(command, workingDirectory);
  return result.exitCode === 0;
}

/**
 * Git pull
 */
export async function gitPull(branch?: string, workingDirectory: string): Promise<boolean> {
  const command = branch ? `git pull origin ${branch}` : "git pull";
  const result = await executeGitCommand(command, workingDirectory);
  return result.exitCode === 0;
}

/**
 * Create new branch
 */
export async function createBranch(
  branchName: string,
  workingDirectory: string,
  checkout: boolean = true
): Promise<boolean> {
  const command = checkout ? `git checkout -b ${branchName}` : `git branch ${branchName}`;
  const result = await executeGitCommand(command, workingDirectory);
  return result.exitCode === 0;
}

/**
 * Switch branch
 */
export async function switchBranch(branchName: string, workingDirectory: string): Promise<boolean> {
  const result = await executeGitCommand(`git checkout ${branchName}`, workingDirectory);
  return result.exitCode === 0;
}

/**
 * Get current branch
 */
export async function getCurrentBranch(workingDirectory: string): Promise<string> {
  const result = await executeGitCommand("git rev-parse --abbrev-ref HEAD", workingDirectory);
  return result.stdout.trim();
}

/**
 * Check if directory is a git repository
 */
export async function isGitRepository(workingDirectory: string): Promise<boolean> {
  const result = await executeGitCommand("git rev-parse --is-inside-work-tree", workingDirectory);
  return result.stdout.trim() === "true";
}

/**
 * Stage all changes
 */
export async function stageAll(workingDirectory: string): Promise<boolean> {
  const result = await executeGitCommand("git add -A", workingDirectory);
  return result.exitCode === 0;
}

/**
 * Stage specific file
 */
export async function stageFile(filePath: string, workingDirectory: string): Promise<boolean> {
  const result = await executeGitCommand(`git add ${filePath}`, workingDirectory);
  return result.exitCode === 0;
}

/**
 * Unstage file
 */
export async function unstageFile(filePath: string, workingDirectory: string): Promise<boolean> {
  const result = await executeGitCommand(`git reset ${filePath}`, workingDirectory);
  return result.exitCode === 0;
}

/**
 * Discard changes in file
 */
export async function discardChanges(filePath: string, workingDirectory: string): Promise<boolean> {
  const result = await executeGitCommand(`git checkout -- ${filePath}`, workingDirectory);
  return result.exitCode === 0;
}
