import { executeCommand } from "./command-execution";

export interface SearchResult {
  id: string;
  filePath: string;
  line: number;
  column: number;
  content: string;
  matchLength: number;
}

export interface FileSearchResult {
  filePath: string;
  matches: number;
  preview: string;
}

/**
 * Search in current file
 */
export async function searchInFile(
  query: string,
  filePath: string,
  sessionId: string,
  _caseSensitive: boolean = false
): Promise<SearchResult[]> {
  const result = await executeCommand({
    sessionId,
    command: `grep -n "${query}" "${filePath}"`,
  });

  const lines = result.output.split("\n");
  return lines
    .filter(line => line.trim())
    .map(line => {
      const [lineNum, ...contentParts] = line.split(":");
      return {
        id: `search-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        filePath,
        line: parseInt(lineNum) || 0,
        column: 1,
        content: contentParts.join(":"),
        matchLength: query.length,
      };
    });
}

/**
 * Search across all files
 */
export async function searchAllFiles(
  query: string,
  directory: string,
  _extensions?: string[],
  sessionId: string,
  _caseSensitive: boolean = false
): Promise<FileSearchResult[]> {
  const result = await executeCommand({
    sessionId,
    command: `grep -r -l "${query}" "${directory}"`,
  });

  const files = result.output.split("\n").filter(f => f.trim());
  return files.map(file => ({
    filePath: file,
    matches: 1,
    preview: "",
  }));
}

/**
 * Grep search
 */
export async function grepSearch(
  pattern: string,
  directory: string,
  sessionId: string,
  _options?: {
    recursive?: boolean;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regex?: boolean;
  }
): Promise<SearchResult[]> {
  const result = await executeCommand({
    sessionId,
    command: `grep -rn "${pattern}" "${directory}"`,
  });

  const lines = result.output.split("\n");
  return lines
    .filter(line => line.trim())
    .map(line => {
      const [filePath, lineNum, ...contentParts] = line.split(":");
      return {
        id: `grep-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        filePath,
        line: parseInt(lineNum) || 0,
        column: 1,
        content: contentParts.join(":"),
        matchLength: pattern.length,
      };
    });
}

/**
 * Replace in file
 */
export async function replaceInFile(
  search: string,
  replace: string,
  filePath: string,
  sessionId: string,
  _caseSensitive: boolean = false,
  _global: boolean = true
): Promise<{ replacements: number; success: boolean }> {
  const result = await executeCommand({
    sessionId,
    command: `sed -i '' "s/${search}/${replace}/g" "${filePath}"`,
  });

  return { replacements: 1, success: result.exitCode === 0 };
}

/**
 * Replace across all files
 */
export async function replaceAllFiles(
  search: string,
  replace: string,
  directory: string,
  sessionId: string,
  _options?: {
    extensions?: string[];
    caseSensitive?: boolean;
    confirm?: boolean;
  }
): Promise<{ files: number; replacements: number; success: boolean }> {
  const result = await executeCommand({
    sessionId,
    command: `find "${directory}" -type f -exec sed -i '' "s/${search}/${replace}/g" {} +`,
  });

  return { files: 1, replacements: 1, success: result.exitCode === 0 };
}

/**
 * Find file by name
 */
export async function findFile(
  fileName: string,
  directory: string,
  sessionId: string
): Promise<string[]> {
  const result = await executeCommand({
    sessionId,
    command: `find "${directory}" -name "${fileName}"`,
  });

  return result.output.split("\n").filter(f => f.trim());
}

/**
 * List files in directory
 */
export async function listFiles(
  directory: string,
  sessionId: string,
  _recursive: boolean = false
): Promise<string[]> {
  const result = await executeCommand({
    sessionId,
    command: `ls -la "${directory}"`,
  });

  return result.output.split("\n").filter(f => f.trim());
}

/**
 * Get file content
 */
export async function getFileContent(filePath: string, sessionId: string): Promise<string> {
  const result = await executeCommand({
    sessionId,
    command: `cat "${filePath}"`,
  });

  return result.output;
}

/**
 * Save file content
 */
export async function saveFileContent(
  filePath: string,
  content: string,
  sessionId: string
): Promise<boolean> {
  const result = await executeCommand({
    sessionId,
    command: `cat > "${filePath}" << 'EOF'\n${content}\nEOF`,
  });

  return result.exitCode === 0;
}
