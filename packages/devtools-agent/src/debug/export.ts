import type { UIMessage } from 'ai';
import { z } from 'zod';
import type { AgentDB } from '../workspace/database';
import type {
  ArtifactRecord,
  BrowserEvent,
  ModelSettings,
  OperationRecord,
  RunRecord,
} from '../protocol/types';
import { createRedactor } from './redact';
import { createZip, type ZipEntry } from './zip';

export const DEBUG_PACK_FORMAT = 'monkeyagent-debug-pack';
export const DEBUG_PACK_SCHEMA_VERSION = 3;
const MAX_TEXT_ARTIFACT = 2 * 1024 * 1024;
const TRANSCRIPT_OUTPUT_LIMIT = 4000;

export interface DebugPackTool {
  description?: string;
  inputSchema?: unknown;
}

export interface DebugPackInput {
  db: AgentDB;
  workspaceId: string;
  sessionId: string;
  /** In-memory conversation; may be newer than the persisted copy while a run is active. */
  messages: UIMessage[];
  /** What convertToModelMessages() produces for `messages`. */
  modelMessages: unknown;
  /** The full system prompt as it would be sent for a run started now. */
  instructions: string;
  tools: Record<string, DebugPackTool>;
  activeTools: readonly string[];
  docs: Record<string, string>;
  settings: ModelSettings;
  browser: { tabId: number; targetUrl: string; connected: boolean; events: BrowserEvent[] };
  runtime: { extension: string; version: string; userAgent: string };
  now?: Date;
}

export interface DebugPack {
  filename: string;
  data: Uint8Array;
  counts: Record<string, number>;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const iso = (time?: number) => (time ? new Date(time).toISOString() : undefined);

function toolSchema(schema: unknown) {
  if (!(schema instanceof z.ZodType)) return schema ?? null;
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any' });
  } catch (error) {
    return { error: `Schema not representable: ${String(error)}` };
  }
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function artifactFile(meta: { id: string; path: string }) {
  return `artifacts/${safeSegment(meta.id)}-${safeSegment(meta.path.split('/').pop() ?? '')}`;
}

function truncate(text: string, limit = TRANSCRIPT_OUTPUT_LIMIT) {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more chars)` : text;
}

function fence(text: string, language = '') {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const marker = '`'.repeat(longest + 1);
  return `${marker}${language}\n${text}\n${marker}`;
}

function transcript(
  session: { title: string; targetUrl: string },
  messages: UIMessage[],
  runs: RunRecord[],
) {
  const lines = [`# ${session.title}`, '', `Target: ${session.targetUrl}`, ''];
  if (runs.length) {
    lines.push('## Runs', '', '| Started | Status | Model | Steps | Tokens in/out | Error |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const run of runs) {
      const input = run.steps?.reduce((sum, step) => sum + (step.inputTokens ?? 0), 0) ?? 0;
      const output = run.steps?.reduce((sum, step) => sum + (step.outputTokens ?? 0), 0) ?? 0;
      const cells = [
        iso(run.startedAt),
        run.status,
        run.model?.model ?? '',
        run.steps?.length ?? 0,
        `${input}/${output}`,
        (run.error ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '),
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  lines.push('## Conversation', '');
  for (const message of messages) {
    const role =
      message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Agent' : message.role;
    lines.push(`### ${role}`, '');
    for (const part of message.parts as unknown as Record<string, any>[]) {
      if (part.type === 'text') lines.push(part.text, '');
      else if (part.type === 'reasoning') continue;
      else if (part.type === 'dynamic-tool' || String(part.type).startsWith('tool-')) {
        const name = part.type === 'dynamic-tool' ? part.toolName : String(part.type).slice(5);
        lines.push(`**Tool \`${name}\`** · ${part.state ?? 'unknown'}`, '');
        if (typeof part.input?.code === 'string') lines.push(fence(part.input.code, 'js'), '');
        else lines.push(fence(truncate(JSON.stringify(part.input ?? null, null, 2)), 'json'), '');
        const output = part.errorText ?? part.output;
        if (output !== undefined)
          lines.push(
            fence(truncate(typeof output === 'string' ? output : JSON.stringify(output, null, 2)), 'json'),
            '',
          );
      }
    }
  }
  return lines.join('\n');
}

export async function buildDebugPack(input: DebugPackInput): Promise<DebugPack> {
  const now = input.now ?? new Date();
  const { db, workspaceId, sessionId } = input;
  const tx = db.transaction(
    ['workspaces', 'sessions', 'conversations', 'runs', 'operations', 'files', 'revisions', 'artifacts'],
    'readonly',
  );
  const [workspace, session, conversation, runs, operations, files, revisions, artifacts] =
    await Promise.all([
      tx.objectStore('workspaces').get(workspaceId),
      tx.objectStore('sessions').get(sessionId),
      tx.objectStore('conversations').get(sessionId),
      tx.objectStore('runs').index('sessionId').getAll(sessionId),
      tx.objectStore('operations').index('sessionId').getAll(sessionId),
      tx.objectStore('files').index('workspaceId').getAll(workspaceId),
      tx.objectStore('revisions').index('workspaceId').getAll(workspaceId),
      tx.objectStore('artifacts').index('workspaceId').getAll(workspaceId),
    ]);
  await tx.done;
  if (!workspace || !session) throw new Error('Session not found.');
  runs.sort((a, b) => a.startedAt - b.startedAt);
  operations.sort((a, b) => a.startedAt - b.startedAt);
  const messages = input.messages.length ? input.messages : (conversation?.messages ?? []);

  // Revisions are shared by the site; keep the session baseline and those made during it.
  const sessionStart = Math.min(
    ...runs.map((run) => run.startedAt),
    ...operations.map((operation) => operation.startedAt),
    now.getTime(),
  );
  const baseline = new Set(Object.values(session.baseline));
  const sessionRevisions = revisions
    .filter((revision) => baseline.has(revision.revision) || revision.updatedAt >= sessionStart)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map(({ key: _key, workspaceId: _workspaceId, ...revision }) => revision);

  // Only text artifacts of this session (large tool results); screenshots are listed, not included.
  const operationText = JSON.stringify(operations);
  const sessionArtifacts = artifacts.filter(
    (artifact) => artifact.sessionId === sessionId || operationText.includes(artifact.id),
  );
  const artifactEntries: { meta: Omit<ArtifactRecord, 'blob'>; text?: string; omitted?: string }[] =
    [];
  for (const { blob, ...meta } of sessionArtifacts) {
    if (!/^(text\/|application\/json)/.test(meta.mimeType))
      artifactEntries.push({ meta, omitted: 'binary (screenshots are not exported)' });
    else if (meta.size > MAX_TEXT_ARTIFACT)
      artifactEntries.push({ meta, omitted: `text above ${MAX_TEXT_ARTIFACT} bytes` });
    else
      try {
        artifactEntries.push({ meta, text: await blob.text() });
      } catch (error) {
        artifactEntries.push({ meta, omitted: `unreadable: ${String(error)}` });
      }
  }

  const replHistory = operations
    .filter((operation) => operation.name === 'repl')
    .map((operation: OperationRecord) => {
      const { code, timeoutMs } = (operation.input ?? {}) as { code?: string; timeoutMs?: number };
      return {
        id: operation.id,
        source: operation.runId ? 'agent' : 'manual',
        runId: operation.runId,
        status: operation.status,
        startedAt: iso(operation.startedAt),
        durationMs: operation.endedAt ? operation.endedAt - operation.startedAt : undefined,
        timeoutMs,
        code,
        result: operation.output,
      };
    });

  const tools = Object.entries(input.tools).map(([name, tool]) => ({
    name,
    active: input.activeTools.includes(name),
    description: tool.description,
    inputSchema: toolSchema(tool.inputSchema),
  }));

  const settings = {
    provider: input.settings.provider,
    baseURL: input.settings.baseURL,
    model: input.settings.model,
    supportsImages: input.settings.supportsImages,
    apiKeyConfigured: !!input.settings.apiKey,
  };

  const redact = createRedactor(input.settings.apiKey ? [input.settings.apiKey] : [], [
    messages,
    runs,
    operations,
    input.browser.events,
  ]);

  const counts = {
    messages: messages.length,
    runs: runs.length,
    operations: operations.length,
    replRuns: replHistory.length,
    files: files.length,
    revisions: sessionRevisions.length,
    artifacts: artifactEntries.filter((entry) => entry.text !== undefined).length,
    browserEvents: input.browser.events.length,
  };

  const manifest = {
    format: DEBUG_PACK_FORMAT,
    schemaVersion: DEBUG_PACK_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    runtime: input.runtime,
    scope: { type: 'session', workspaceId, site: workspace.site, sessionId, title: session.title },
    counts,
    layout: {
      'settings.json': 'Model configuration at export time (API key removed).',
      'agent/': 'System prompt, tool definitions and /docs guides as the agent sees them now.',
      'session/': 'Session metadata, conversation, model input, runs, operations, REPL history, transcript.',
      'workspace/': 'Script bindings, current files as real files, revisions, text artifacts.',
      'browser/': 'Inspected tab and the in-memory CDP event buffer (console, logs, network).',
    },
    limitations: [
      '/source is an ephemeral read-only view of browser-provided sources. Its index and cache are not exported automatically; explicitly saved source excerpts may appear in conversation, operations or workspace files.',
      'agent/instructions.md and tool definitions are rebuilt at export time; earlier runs may have used a different prompt, directory listing or extension version.',
      'Configuration is captured at export time, not per run. Runs record their own model in session/runs.json.',
      'Raw model HTTP streams and hidden reasoning are not persisted.',
      'browser/events.json holds only the current in-memory buffer (up to 2000 events / 2 MiB) since the debugger connected.',
      'Screenshots and other binary artifacts are not exported; text artifacts are included up to 2 MiB each.',
      'Workspace files and revisions are shared by all sessions of the site; revisions are limited to the session baseline and those made during the session.',
      'Common credentials and the configured model key are redacted. Scripts and page data are otherwise included; review before sharing.',
    ],
  };

  const entries: ZipEntry[] = [
    { name: 'manifest.json', data: json(manifest) },
    { name: 'settings.json', data: json(redact.value(settings)) },
    { name: 'agent/instructions.md', data: redact.text(input.instructions) },
    { name: 'agent/tools.json', data: json(tools) },
    ...Object.entries(input.docs).map(([path, content]) => ({
      name: `agent${path}`,
      data: content,
    })),
    { name: 'session/session.json', data: json(redact.value(session)) },
    { name: 'session/messages.json', data: json(redact.value(messages)) },
    { name: 'session/model-messages.json', data: json(redact.value(input.modelMessages)) },
    { name: 'session/runs.json', data: json(redact.value(runs)) },
    { name: 'session/operations.json', data: json(redact.value(operations)) },
    { name: 'session/repl-history.json', data: json(redact.value(replHistory)) },
    {
      name: 'session/transcript.md',
      data: redact.text(transcript(session, messages, runs)),
    },
    { name: 'workspace/workspace.json', data: json(redact.value(workspace)) },
    ...files.map((file) => ({
      name: `workspace/files${file.path}`,
      data: redact.text(file.content),
      date: new Date(file.updatedAt),
    })),
    {
      name: 'workspace/files.json',
      data: json(
        files.map(({ path, revision, updatedAt, content }) => ({
          path,
          revision,
          updatedAt: iso(updatedAt),
          size: content.length,
        })),
      ),
    },
    { name: 'workspace/revisions.json', data: json(redact.value(sessionRevisions)) },
    {
      name: 'workspace/artifacts.json',
      data: json(
        artifactEntries.map(({ meta, omitted }) => ({
          ...meta,
          createdAt: iso(meta.createdAt),
          ...(omitted ? { omitted } : { file: artifactFile(meta) }),
        })),
      ),
    },
    ...artifactEntries
      .filter((entry) => entry.text !== undefined)
      .map(({ meta, text }) => ({
        name: `workspace/${artifactFile(meta)}`,
        data: String(redact.value(text!)),
      })),
    {
      name: 'browser/target.json',
      data: json(
        redact.value({
          tabId: input.browser.tabId,
          targetUrl: input.browser.targetUrl,
          connected: input.browser.connected,
        }),
      ),
    },
    { name: 'browser/events.json', data: json(redact.value(input.browser.events)) },
  ];

  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return {
    filename: `monkeyagent-debug-${safeSegment(workspace.site)}-${stamp}.zip`,
    data: await createZip(entries, now),
    counts,
  };
}
