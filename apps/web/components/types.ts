export type Session = {
  id: string;
  kind: string;
  tmuxName: string;
  tmuxWindowName?: string | null;
  tmuxManaged: boolean;
  agentType?: string | null;
  spawnCommand?: string | null;
  status: string;
  runtime?: "herdr" | "tmux" | string;
  runtimeSessionId?: string | null;
  externalId?: string | null;
  terminalId?: string | null;
  controllerMode?: string;
};

export type Tab = {
  id: string;
  name: string;
  ordinal: number;
  status: string;
  session?: Session | null;
  externalId?: string | null;
  runtimeTabId?: string | null;
  runtimeTabName?: string | null;
  runtimeTabStatus?: string | null;
  runtimePaneId?: string | null;
  runtimePaneName?: string | null;
  runtimePaneIndex?: number | null;
  layout?: string | null;
  focused?: boolean;
};

export type Project = {
  id: string;
  name: string;
  rootKey: string;
  relativePath: string;
  tmuxSessionName?: string | null;
  tmuxManaged: boolean;
  agentType: string;
  agentSpawnCommand: string;
  status: string;
  position?: number | null;
  openedAt: string | Date;
  tabs: Tab[];
  sessions: Session[];
  deviceId?: string | null;
  runtime?: "herdr" | "tmux" | string;
  runtimeSessionId?: string | null;
  runtimeSessionName?: string | null;
  runtimeSpaceName?: string | null;
  runtimeIconStyle?: "dots" | "symbols" | string | null;
  runtimeOrdinal?: number | null;
  runtimeFocused?: boolean;
  externalId?: string | null;
  creationPath?: string | null;
  mirrored?: boolean;
};

export type TmuxWindow = {
  index: number;
  id: string;
  name: string;
  target: string;
  path?: string;
};

export type TmuxDeviceSession = {
  name: string;
  path?: string;
  windowCount?: number;
  windows: TmuxWindow[];
};

export type AgentDeviceStatus = {
  name: string;
  connected: boolean;
  version?: string | null;
  fake?: boolean;
  streamCount?: number;
  uptimeSec?: number;
  memMb?: number;
  memPeakMb?: number;
  kind?: "agent" | "ssh";
  lastSeenAt?: string | null;
  roots?: Record<string, string>;
  tmuxSessions?: TmuxDeviceSession[];
  deviceId?: string | null;
  protocolVersion?: number;
  capabilities?: Record<string, boolean>;
  runtimeSessions?: Array<{
    kind: "herdr" | "tmux" | string;
    available: boolean;
    sessions: Array<{ id: string; name: string }>;
  }>;
};
