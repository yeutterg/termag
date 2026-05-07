export type Session = {
  id: string;
  kind: string;
  tmuxName: string;
  agentType?: string | null;
  spawnCommand?: string | null;
  status: string;
};

export type Tab = {
  id: string;
  name: string;
  ordinal: number;
  status: string;
  session?: Session | null;
};

export type Project = {
  id: string;
  name: string;
  rootKey: string;
  relativePath: string;
  agentType: string;
  agentSpawnCommand: string;
  status: string;
  position?: number | null;
  openedAt: string | Date;
  tabs: Tab[];
  sessions: Session[];
};
