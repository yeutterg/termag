export type Session = {
  id: string;
  status: string;
};

export type Tab = {
  id: string;
  name: string;
  ordinal: number;
  status: string;
  session?: Session | null;
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
  directoryRootKey?: string | null;
  status: string;
  tabs: Tab[];
  deviceId: string;
  runtime: "herdr" | "tmux";
  runtimeSessionId: string;
  runtimeSessionName: string;
  runtimeSpaceName: string;
  runtimeIconStyle?: "dots" | "symbols" | string | null;
  runtimeOrdinal: number;
  runtimeFocused: boolean;
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
  roots?: Record<string, string>;
  deviceId?: string | null;
  protocolVersion?: number;
  capabilities?: Record<string, boolean>;
  runtimeSessions?: Array<{
    kind: "herdr" | "tmux" | string;
    available: boolean;
    sessions: Array<{ id: string; name: string }>;
  }>;
};
