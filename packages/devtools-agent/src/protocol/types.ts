import type { UIMessage } from 'ai';

export type RunStatus =
  | 'idle'
  | 'generating'
  | 'executing'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'limit_reached';
export interface AgentErrorData {
  code: string;
  message: string;
}
export interface FileRecord {
  path: string;
  content: string;
  revision: string;
  updatedAt: number;
}
export interface ScriptSummary {
  id: string;
  name: string;
  enabled: boolean;
}
export interface ScriptSnapshot extends ScriptSummary {
  code: string;
  revision: string;
}
export interface ScriptStoreAdapter {
  list(): Promise<ScriptSummary[]>;
  get(id: string): Promise<ScriptSnapshot>;
  save(input: { id?: string; code: string }): Promise<ScriptSnapshot>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}
export interface ScriptBinding {
  path: string;
  scriptId: string;
  scriptRevision: string;
  fileRevision: string;
  installedCode: string;
  enabled: boolean;
  verification?: { passed: boolean; detail: string; at: number };
}
export interface WorkspaceRecord {
  id: string;
  site: string;
  updatedAt: number;
  bindings: Record<string, ScriptBinding>;
}
export interface SessionRecord {
  id: string;
  workspaceId: string;
  conversationId?: string;
  title: string;
  targetUrl: string;
  targetTabId?: number;
  updatedAt: number;
  baseline: Record<string, string>;
}
export interface RunRecord {
  id: string;
  workspaceId: string;
  sessionId: string;
  conversationId?: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
  queued: string[];
  model?: Pick<ModelSettings, 'provider' | 'baseURL' | 'model' | 'supportsImages'>;
  finishReason?: string;
  steps?: {
    index: number;
    endedAt: number;
    finishReason: string;
    inputTokens?: number;
    outputTokens?: number;
    toolCalls: { toolCallId: string; toolName: string }[];
  }[];
}
export interface OperationRecord {
  id: string;
  workspaceId: string;
  sessionId: string;
  runId?: string;
  name: string;
  input: unknown;
  status: 'started' | 'completed' | 'failed' | 'unknown';
  startedAt: number;
  endedAt?: number;
  output?: unknown;
}
export interface ArtifactRef {
  id: string;
  path: string;
  mimeType: string;
  size: number;
}
export interface ArtifactRecord extends ArtifactRef {
  workspaceId: string;
  sessionId?: string;
  blob: Blob;
  createdAt: number;
}
export interface BrowserEvent {
  seq: number;
  method: string;
  params: unknown;
  sessionId?: string;
  at: number;
}
export interface ModelSettings {
  provider: 'openai-compatible';
  baseURL: string;
  model: string;
  apiKey: string;
  supportsImages: boolean;
  theme: 'system' | 'light' | 'dark';
}
export interface Snapshot {
  workspace: WorkspaceRecord;
  session: SessionRecord;
  files: FileRecord[];
  messages: UIMessage[];
  run?: RunRecord;
  connected: boolean;
  events: BrowserEvent[];
  history: SessionRecord[];
  operations: OperationRecord[];
  error?: string;
}
export interface ToolResult {
  success: boolean;
  value?: unknown;
  error?: AgentErrorData;
  durationMs: number;
  artifacts?: ArtifactRef[];
  truncated?: boolean;
  warnings?: { code: string; message: string; path: string }[];
}
export type PortRequest = { type: 'request'; id: string; method: string; args: unknown[] };
export type PortResponse = {
  type: 'response';
  id: string;
  result?: unknown;
  error?: AgentErrorData;
};
export type PortEvent = {
  type: 'event';
  event: 'snapshot' | 'chunk' | 'stream-end' | 'stream-error';
  data: unknown;
  streamId?: string;
};
