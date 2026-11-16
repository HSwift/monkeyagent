import { useEffect, useState } from 'react';
import { Play, Camera, PlugZap, Unplug, LoaderCircle } from 'lucide-react';
import { Button, Scroller } from '../components/ui';
import { CodeEditor } from '../components/code-editor';
import { ArtifactImage } from '../components/conversation';
import type { ControllerClient } from '../protocol/client';
import type { ArtifactRef, BrowserEvent, Snapshot, ToolResult } from '../protocol/types';

export function DebugPane({
  client,
  snapshot,
  report,
}: {
  client: ControllerClient;
  snapshot: Snapshot;
  report: (error: unknown) => void;
}) {
  const [tab, setTab] = useState('repl');
  const [code, setCode] = useState('return await browser.evaluate("document.title");');
  const [result, setResult] = useState<ToolResult>();
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [artifacts, setArtifacts] = useState<ArtifactRef[]>([]);
  const lastOperation = snapshot.operations[0];
  useEffect(() => {
    if (tab === 'screenshots')
      client.call<ArtifactRef[]>('artifacts.list').then(setArtifacts).catch(report);
  }, [tab, lastOperation?.id, lastOperation?.status]);
  async function run(source = code) {
    setBusy(true);
    try {
      setResult(await client.call<ToolResult>('repl.run', source));
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  const events = snapshot.events
    .filter((event) =>
      tab === 'network'
        ? event.method.startsWith('Network.')
        : /consoleAPICalled|exceptionThrown|Log.entryAdded/.test(event.method),
    )
    .filter(
      (event) => !filter || JSON.stringify(event).toLowerCase().includes(filter.toLowerCase()),
    );
  return (
    <div className="debug-pane">
      <div className="debug-header">
        <span className={`connection-state ${snapshot.connected ? 'online' : ''}`}>
          <span className="status-dot" />
          {snapshot.connected ? 'Debugger connected' : 'Debugger disconnected'}
        </span>
        <Button
          onClick={() =>
            void client
              .call(snapshot.connected ? 'browser.disconnect' : 'browser.connect')
              .catch(report)
          }
        >
          {snapshot.connected ? <Unplug size={13} /> : <PlugZap size={13} />}
          {snapshot.connected ? 'Disconnect' : 'Connect to page'}
        </Button>
        <Button
          onClick={() => {
            setTab('screenshots');
            void run('return await browser.screenshot();');
          }}
        >
          <Camera size={13} />
          Capture screenshot
        </Button>
      </div>
      <div className="debug-tool-select">
        <select
          aria-label="Debug tool"
          value={tab}
          onChange={(event) => setTab(event.target.value)}
        >
          <option value="repl">JavaScript REPL</option>
          <option value="logs">Logs</option>
          <option value="network">Network</option>
          <option value="screenshots">Screenshots</option>
        </select>
      </div>
      <div className="debug-content" hidden={tab !== 'repl'}>
        <div className="repl-editor">
          <CodeEditor
            value={code}
            onChange={setCode}
            label="JavaScript REPL"
            onRun={() => {
              if (!busy) void run();
            }}
          />
        </div>
        <div className="repl-toolbar">
          <span>JavaScript · await / return · Ctrl/⌘ Enter</span>
          <Button variant="primary" onClick={() => void run()} disabled={busy}>
            {busy ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}Run
          </Button>
          {busy && <Button onClick={() => void client.call('stop').catch(report)}>Stop</Button>}
        </div>
        <Scroller className="repl-output">
          {result && (
            <div className={result.success ? '' : 'error-text'}>
              <p className="eyebrow">
                {result.success ? 'Result' : 'Execution failed'} · {Math.round(result.durationMs)}{' '}
                ms
              </p>
              <pre>{JSON.stringify(result.value ?? result.error, null, 2)}</pre>
            </div>
          )}
          <p className="eyebrow">Execution history</p>
          {snapshot.operations
            .filter((operation) => operation.name === 'repl')
            .map((operation) => (
              <details key={operation.id} className="operation-record">
                <summary>
                  <span>{operation.status}</span>
                  <span>{new Date(operation.startedAt).toLocaleTimeString('en-US')}</span>
                </summary>
                <pre>{(operation.input as { code?: string })?.code}</pre>
                <Button
                  variant="ghost"
                  onClick={() => setCode((operation.input as { code?: string })?.code ?? '')}
                >
                  Copy to editor
                </Button>
                <pre>{JSON.stringify(operation.output, null, 2)}</pre>
              </details>
            ))}
        </Scroller>
      </div>
      {['logs', 'network'].map((value) => (
        <div key={value} className="debug-content" hidden={tab !== value}>
          <div className="filter-bar">
            <input
              aria-label="Filter events"
              placeholder="Filter events…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <span className="muted small">
              Latest {events.length} {events.length === 1 ? 'event' : 'events'}
            </span>
          </div>
          <Scroller>
            {events.length ? (
              events.map((event) => (
                <EventRow
                  key={event.seq}
                  event={event}
                  body={async (requestId) => {
                    setTab('repl');
                    await run(
                      `return await browser.responseBody(${JSON.stringify(requestId)}${event.sessionId ? ', ' + JSON.stringify(event.sessionId) : ''});`,
                    );
                  }}
                />
              ))
            ) : (
              <div className="empty-debug">
                {snapshot.connected
                  ? 'No matching events in the current buffer.'
                  : 'Connect the debugger to collect events from the current page.'}
              </div>
            )}
          </Scroller>
        </div>
      ))}
      <div className="debug-content" hidden={tab !== 'screenshots'}>
        <Scroller>
          <div className="screenshot-grid">
            {artifacts
              .filter((artifact) => artifact.mimeType.startsWith('image/'))
              .map((artifact) => (
                <ArtifactImage key={artifact.id} reference={artifact} client={client} />
              ))}
            {!artifacts.length && (
              <div className="empty-debug">Capture a screenshot to save the current page.</div>
            )}
          </div>
        </Scroller>
      </div>
    </div>
  );
}
function EventRow({ event, body }: { event: BrowserEvent; body: (requestId: string) => void }) {
  const params = event.params as Record<string, any>;
  const summary =
    params.request?.url ??
    params.response?.url ??
    params.entry?.text ??
    params.exceptionDetails?.exception?.description ??
    params.args
      ?.map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description)
      .join(' ') ??
    '';
  return (
    <details className="event-row">
      <summary>
        <time>{new Date(event.at).toLocaleTimeString('en-US')}</time>
        <span>{event.method.replace(/^(Runtime|Network|Log)\./, '')}</span>
        <span className="event-summary">{String(summary).slice(0, 500)}</span>
      </summary>
      <pre>{JSON.stringify(event.params, null, 2)}</pre>
      {params.requestId && (
        <Button variant="ghost" onClick={() => body(params.requestId)}>
          Read response body
        </Button>
      )}
    </details>
  );
}
