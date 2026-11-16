import { useEffect, useState } from 'react';
import { Play, Camera, PlugZap, Unplug, LoaderCircle } from 'lucide-react';
import { Tabs, Button, Scroller } from '../components/ui';
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
    <Tabs.Root value={tab} onValueChange={setTab} className="debug-pane">
      <div className="debug-header">
        <span className={`connection-state ${snapshot.connected ? 'online' : ''}`}>
          <span className="status-dot" />
          {snapshot.connected ? '调试已连接' : '调试未连接'}
        </span>
        <Button
          onClick={() =>
            void client
              .call(snapshot.connected ? 'browser.disconnect' : 'browser.connect')
              .catch(report)
          }
        >
          {snapshot.connected ? <Unplug size={13} /> : <PlugZap size={13} />}
          {snapshot.connected ? '断开' : '连接当前网页'}
        </Button>
        <Button
          onClick={() => {
            setTab('screenshots');
            void run('return await browser.screenshot();');
          }}
        >
          <Camera size={13} />
          截图
        </Button>
      </div>
      <Tabs.List className="tab-list debug-tab-list" aria-label="调试工具">
        <Tabs.Trigger value="repl">REPL</Tabs.Trigger>
        <Tabs.Trigger value="logs">日志</Tabs.Trigger>
        <Tabs.Trigger value="network">网络</Tabs.Trigger>
        <Tabs.Trigger value="screenshots">截图</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="repl" className="debug-content">
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
            {busy ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}执行
          </Button>
          {busy && <Button onClick={() => void client.call('stop').catch(report)}>停止</Button>}
        </div>
        <Scroller className="repl-output">
          {result && (
            <div className={result.success ? '' : 'error-text'}>
              <p className="eyebrow">
                {result.success ? '执行结果' : '执行失败'} · {Math.round(result.durationMs)} ms
              </p>
              <pre>{JSON.stringify(result.value ?? result.error, null, 2)}</pre>
            </div>
          )}
          <p className="eyebrow">执行记录</p>
          {snapshot.operations
            .filter((operation) => operation.name === 'repl')
            .map((operation) => (
              <details key={operation.id} className="operation-record">
                <summary>
                  <span>{operation.status}</span>
                  <span>{new Date(operation.startedAt).toLocaleTimeString()}</span>
                </summary>
                <pre>{(operation.input as { code?: string })?.code}</pre>
                <Button
                  variant="ghost"
                  onClick={() => setCode((operation.input as { code?: string })?.code ?? '')}
                >
                  复制到编辑器
                </Button>
                <pre>{JSON.stringify(operation.output, null, 2)}</pre>
              </details>
            ))}
        </Scroller>
      </Tabs.Content>
      {['logs', 'network'].map((value) => (
        <Tabs.Content key={value} value={value} className="debug-content">
          <div className="filter-bar">
            <input
              aria-label="筛选事件"
              placeholder="筛选内容…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <span className="muted small">最近 {events.length} 条</span>
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
                  ? '当前缓冲区暂无匹配事件。'
                  : '连接调试后将收集当前网页的事件。'}
              </div>
            )}
          </Scroller>
        </Tabs.Content>
      ))}
      <Tabs.Content value="screenshots" className="debug-content">
        <Scroller>
          <div className="screenshot-grid">
            {artifacts
              .filter((artifact) => artifact.mimeType.startsWith('image/'))
              .map((artifact) => (
                <ArtifactImage key={artifact.id} reference={artifact} client={client} />
              ))}
            {!artifacts.length && <div className="empty-debug">点击截图保存当前网页画面。</div>}
          </div>
        </Scroller>
      </Tabs.Content>
    </Tabs.Root>
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
        <time>{new Date(event.at).toLocaleTimeString()}</time>
        <span>{event.method.replace(/^(Runtime|Network|Log)\./, '')}</span>
        <span className="event-summary">{String(summary).slice(0, 500)}</span>
      </summary>
      <pre>{JSON.stringify(event.params, null, 2)}</pre>
      {params.requestId && (
        <Button variant="ghost" onClick={() => body(params.requestId)}>
          读取响应正文
        </Button>
      )}
    </details>
  );
}
