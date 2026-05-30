# Command Palette Integration Guide

## 🎯 Integration Overview

The command palette backend systems are complete with data structures, state management, and UI. To make them fully functional, you need to connect the execution layer to your termag WebSocket/agent architecture.

---

## 🔌 Integration Points

### 1. Terminal Command Execution

**Current State:** `lib/git-operations.ts`, `lib/search-operations.ts` use `console.log`

**Required Change:** Connect to your WebSocket broker

**File to Modify:** `lib/command-execution.ts`

```typescript
// Replace the mock fetch with actual WebSocket call via broker
import { broker } from "./broker";

export async function executeCommand(options: CommandExecutionOptions): Promise<CommandResult> {
  // Get the session to find the project and device
  const session = await prisma.session.findUnique({
    where: { id: options.sessionId },
    include: {
      tab: { include: { project: true } },
    },
  });

  if (!session) {
    throw new Error("Session not found");
  }

  // Send command to agent via broker
  const live = broker();
  if (!live?.executeCommand) {
    throw new Error("Agent offline");
  }

  // You'll need to add executeCommand to the broker interface in lib/broker.ts
  const result = await live.executeCommand(
    session.tab.project.userId,
    session.tab.project.rootKey,
    options.sessionId,
    options.command,
    options.workingDirectory
  );

  return result;
}
```

**Add to Broker Interface** (`lib/broker.ts`):

```typescript
type Broker = {
  // ... existing methods
  executeCommand?: (
    userId: string,
    deviceName: string,
    sessionId: string,
    command: string,
    workingDirectory?: string
  ) => Promise<{ output: string; exitCode: number }>;
};
```

---

### 2. Update Git Operations

**File:** `lib/git-operations.ts`

Add sessionId parameter to all functions:

```typescript
export async function getGitStatus(
  workingDirectory: string,
  sessionId: string // Add this parameter
): Promise<GitStatus> {
  const result = await executeGitCommand(
    "git status --porcelain",
    workingDirectory,
    sessionId // Pass through
  );
  // ... rest of implementation
}

export async function gitCommit(
  message: string,
  workingDirectory: string,
  sessionId: string // Add this parameter
): Promise<boolean> {
  const result = await executeGitCommand(`git commit -m "${message}"`, workingDirectory, sessionId);
  return result.exitCode === 0;
}

// Do the same for all git functions
```

---

### 3. Update Search Operations

**File:** `lib/search-operations.ts`

Add sessionId parameter and use actual file operations:

```typescript
export async function searchInFile(
  query: string,
  filePath: string,
  sessionId: string, // Add this parameter
  caseSensitive: boolean = false
): Promise<SearchResult[]> {
  const result = await executeCommand({
    sessionId,
    command: `grep -n "${query}" "${filePath}"`,
    workingDirectory: undefined,
  });

  // Parse grep output into SearchResult[]
  const lines = result.output.split("\n");
  return lines.map(line => {
    const [lineNum, ...contentParts] = line.split(":");
    return {
      id: `search-${Date.now()}`,
      filePath,
      line: parseInt(lineNum),
      column: 1,
      content: contentParts.join(":"),
      matchLength: query.length,
    };
  });
}
```

---

### 4. Update UI Components

**File:** `components/git-operations-dialog.tsx`

Add sessionId prop and pass to git operations:

```typescript
interface GitOperationsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workingDirectory: string;
  sessionId: string; // Add this
  onCommandExecute?: (command: string) => void;
  className?: string;
}

// Update function calls
const [status, setStatus] = useState<GitStatus | null>(null);

const loadGitData = async () => {
  setLoading(true);
  try {
    const [statusData, branchesData] = await Promise.all([
      getGitStatus(workingDirectory, sessionId), // Pass sessionId
      getGitBranches(workingDirectory, sessionId),
    ]);
    setStatus(statusData);
    setBranches(branchesData);
  } catch (error) {
    console.error("Failed to load git data:", error);
  } finally {
    setLoading(false);
  }
};
```

---

### 5. Update Command Palette

**File:** `components/command-palette.tsx`

Add sessionId parameter to getTermagCommands and pass through to all callbacks:

```typescript
export function getTermagCommands(options: {
  sessionId: string;  // Add this
  // ... other options

  // Git Operations
  onGitStatus?: () => void;
  // ... other callbacks
}): Command[] {
  const { sessionId } = options;

  // When creating git commands, use the sessionId
  {
    id: 'git-status',
    label: 'Git Status',
    action: () => {
      if (onGitStatus) {
        // The actual git operation will use the sessionId internally
        // You may need to pass it through or store it in context
        onGitStatus();
      }
    }
  }
}
```

---

## 🚀 Quick Start Integration

### Step 1: Add executeCommand to Broker

1. Open `lib/broker.ts`
2. Add to the Broker type interface
3. Implement in your WebSocket server (apps/agent or wherever the broker is implemented)
4. The function should send the command to the agent and return the output

### Step 2: Add executeCommand API Route

Already created: `apps/web/app/api/terminal/execute/route.ts`

This route:

- Verifies the session exists
- Gets the agent token for the project
- Returns mock response (needs WebSocket integration)

### Step 3: Update executeCommand in command-execution.ts

Replace the mock fetch with actual broker call as shown above.

### Step 4: Wire Up sessionId in UI Components

Add sessionId as a prop to:

- GitOperationsDialog
- SearchDialog
- TabBar (for context)
- Any component that needs to execute commands

### Step 5. Pass sessionId Through Command Palette

Update your main app component to:

1. Track the active session ID
2. Pass it to getTermagCommands
3. Pass it to dialog components

---

## 📋 Integration Checklist

- [ ] Add executeCommand to Broker interface
- [ ] Implement executeCommand in WebSocket server
- [ ] Update executeCommand in command-execution.ts to use broker
- [ ] Add sessionId parameter to all git operations
- [ ] Add sessionId parameter to all search operations
- [ ] Update UI components to accept sessionId prop
- [ ] Update command palette to pass sessionId
- [ ] Test git operations in actual terminal
- [ ] Test search operations in actual terminal
- [ ] Test clipboard operations
- Test session management

---

## 💡 Architecture Notes

Based on AGENTS.md:

- Single-user, single-VPS architecture
- Projects use named roots (rootKey + relativePath)
- Tmux sessions: `termag-{projectId}-{tabId}` for agent tabs
- Each project has one agent type and one shared ctrl session
- Agent tokens are stored in Prisma with userId and device name

The sessionId should map to a specific tab in a project, which has:

- projectId → maps to rootKey
- tabId → maps to tmux session name

When executing commands, you need to:

1. Resolve sessionId → project → rootKey
2. Get agent token for that rootKey and userId
3. Send command to agent via WebSocket
4. Return output to caller
