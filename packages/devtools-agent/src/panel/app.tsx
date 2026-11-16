import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DropdownMenu } from 'radix-ui';
import {
  Plus,
  SquarePen,
  History,
  Settings2,
  ArrowUp,
  Square,
  Paperclip,
  X,
  Globe2,
  MoreHorizontal,
  ChevronDown,
  AlertCircle,
  RotateCcw,
} from 'lucide-react';
import { Button, IconButton, Modal, Scroller, Tooltip } from '../components/ui';
import { Conversation, ChatMessage } from '../components/conversation';
import { ControllerChatTransport, type ControllerClient } from '../protocol/client';
import type { ModelSettings, Snapshot } from '../protocol/types';
import { Settings } from './settings';
import type { WorkspaceView } from './workspace';
const WorkspacePane = lazy(() =>
  import('./workspace').then((module) => ({ default: module.WorkspacePane })),
);

type Attachment = { path: string; content: string; selection: string };
const DRAWERS: { view: WorkspaceView; label: string }[] = [
  { view: 'files', label: '文件' },
  { view: 'changes', label: '变更' },
  { view: 'debug', label: '调试' },
];
const STATUS_LABELS: Record<string, string> = {
  idle: '就绪',
  generating: '正在生成',
  executing: '工具执行中',
  stopping: '正在停止',
  completed: '任务完成',
  failed: '任务失败',
  interrupted: '任务已中断',
  limit_reached: '达到步骤上限',
};
const running = (snapshot: Snapshot) =>
  ['generating', 'executing', 'stopping'].includes(snapshot.run?.status ?? '');
export function App({ client }: { client: ControllerClient }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [model, setModel] = useState('配置模型');
  const [selectedPath, setSelectedPath] = useState('/workspace/main.user.js');
  const [drawerView, setDrawerView] = useState<WorkspaceView>('files');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTriggers = useRef<Partial<Record<WorkspaceView, HTMLButtonElement | null>>>({});
  const [attachment, setAttachment] = useState<Attachment>();
  function report(error: unknown) {
    setError(error instanceof Error ? error.message : String(error));
  }
  function applySettings(settings: ModelSettings) {
    setModel(settings.model || '配置模型');
    const system =
      globalThis.chrome?.devtools?.panels?.themeName ??
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = settings.theme === 'system' ? system : settings.theme;
  }
  useEffect(() => {
    const unsubscribe = client.subscribe(setSnapshot);
    client.call<Snapshot>('snapshot').then(setSnapshot).catch(report);
    client.call<ModelSettings>('settings.get').then(applySettings).catch(report);
    return unsubscribe;
  }, []);
  useEffect(() => {
    setAttachment(undefined);
    setError('');
    setClearOpen(false);
  }, [snapshot?.session.id]);
  useEffect(() => {
    const stop = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === '.') {
        event.preventDefault();
        void client.call('stop').catch(report);
      }
    };
    window.addEventListener('keydown', stop);
    return () => window.removeEventListener('keydown', stop);
  }, [client]);
  useEffect(() => {
    if (!drawerOpen) return;
    const dismiss = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('[role="dialog"], [role="menu"]')
      ) {
        event.preventDefault();
        closeDrawer();
      }
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [drawerOpen, drawerView]);
  useEffect(() => {
    if (
      snapshot &&
      !snapshot.files.some((file) => file.path === selectedPath) &&
      snapshot.files.length
    )
      setSelectedPath(snapshot.files[0].path);
  }, [snapshot?.files.map((file) => file.path).join('|')]);
  async function newSession() {
    const value = await client.call<Snapshot>('session.new');
    setSnapshot(value);
    setAttachment(undefined);
    setDrawerOpen(false);
  }
  async function clearConversation() {
    setClearing(true);
    try {
      const value = await client.call<Snapshot>('chat.clear');
      setSnapshot(value);
      setError('');
      setAttachment(undefined);
      setDrawerOpen(false);
      setClearOpen(false);
    } catch (error) {
      report(error);
    } finally {
      setClearing(false);
    }
  }
  function openFile(path: string) {
    setSelectedPath(path);
    openDrawer('changes');
  }
  function openDrawer(view: WorkspaceView) {
    setDrawerView(view);
    setDrawerOpen(true);
  }
  function closeDrawer() {
    setDrawerOpen(false);
    drawerTriggers.current[drawerView]?.focus({ preventScroll: true });
  }
  let host = '';
  try {
    host = new URL(snapshot?.session.targetUrl ?? '').host;
  } catch {}
  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="app">
        <header className="app-header">
          <button
            className="model-select"
            onClick={() => setSettingsOpen(true)}
            aria-label="模型设置"
            title="选择和配置模型"
          >
            <strong>Agent</strong>
            {model !== '配置模型' && <span>{model}</span>}
            <ChevronDown size={14} />
          </button>
          <div className="header-actions">
            {snapshot &&
              (running(snapshot) ||
                snapshot.operations.some((operation) => operation.status === 'started')) && (
                <IconButton
                  label="停止当前运行 (Ctrl/⌘ .)"
                  onClick={() => void client.call('stop').catch(report)}
                >
                  <Square size={13} />
                </IconButton>
              )}
            <IconButton
              label="新会话"
              disabled={clearing || (!!snapshot && running(snapshot))}
              onClick={() => void newSession().catch(report)}
            >
              <SquarePen size={17} />
            </IconButton>
            <nav className="drawer-actions" aria-label="辅助工具">
              {DRAWERS.map(({ view, label }) => (
                <Button
                  key={view}
                  ref={(element) => {
                    drawerTriggers.current[view] = element;
                  }}
                  variant="ghost"
                  className="drawer-toggle"
                  aria-expanded={drawerOpen && drawerView === view}
                  aria-controls="tool-drawer"
                  onClick={() => {
                    if (drawerOpen && drawerView === view) closeDrawer();
                    else openDrawer(view);
                  }}
                >
                  {label}
                </Button>
              ))}
            </nav>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="button button-ghost icon-button" aria-label="更多操作">
                  <MoreHorizontal size={18} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="action-menu" align="end" sideOffset={8}>
                  <DropdownMenu.Item onSelect={() => setHistoryOpen(true)}>
                    <History size={15} />
                    会话历史
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => setSettingsOpen(true)}>
                    <Settings2 size={15} />
                    模型设置
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item disabled={clearing} onSelect={() => setClearOpen(true)}>
                    <RotateCcw size={15} />
                    清空上下文
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>
        {(error || snapshot?.error) && (
          <div className="error-banner app-error" role="alert">
            <AlertCircle size={14} />
            <span>{error || snapshot?.error}</span>
            <Button
              variant="ghost"
              onClick={() => {
                setError('');
                void client.call('error.clear');
              }}
              aria-label="关闭错误"
            >
              <X size={13} />
            </Button>
          </div>
        )}
        {snapshot ? (
          <main className="main-layout">
            <div className="chat-layout" inert={drawerOpen}>
              <ChatArea
                key={snapshot.session.conversationId ?? snapshot.session.id}
                client={client}
                snapshot={snapshot}
                openFile={openFile}
                report={report}
                configure={() => setSettingsOpen(true)}
                attachment={attachment}
                clearAttachment={() => setAttachment(undefined)}
                openWorkspace={() => openDrawer('files')}
                host={host}
                configured={model !== '配置模型'}
              />
            </div>
            {drawerOpen && (
              <button
                className="drawer-backdrop"
                tabIndex={-1}
                aria-hidden="true"
                onClick={closeDrawer}
              />
            )}
            <aside
              id="tool-drawer"
              className="tool-drawer"
              aria-label={`${DRAWERS.find(({ view }) => view === drawerView)?.label}抽屉`}
              hidden={!drawerOpen}
            >
              <Suspense fallback={<div className="loading-app">正在打开…</div>}>
                <WorkspacePane
                  key={snapshot.workspace.id}
                  client={client}
                  snapshot={snapshot}
                  selectedPath={selectedPath}
                  selectFile={setSelectedPath}
                  view={drawerView}
                  setView={setDrawerView}
                  open={drawerOpen}
                  close={closeDrawer}
                  report={report}
                  attach={(attachment) => {
                    setAttachment(attachment);
                    setDrawerOpen(false);
                    requestAnimationFrame(() =>
                      document
                        .querySelector<HTMLTextAreaElement>('.prompt-form textarea')
                        ?.focus({ preventScroll: true }),
                    );
                  }}
                />
              </Suspense>
            </aside>
          </main>
        ) : (
          <div className="loading-app">
            <p>正在连接开发者工具…</p>
          </div>
        )}
        <Settings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          client={client}
          saved={applySettings}
        />
        <Modal
          open={clearOpen}
          onOpenChange={(open) => {
            if (!clearing) setClearOpen(open);
          }}
          title="清空对话上下文"
          description="清除当前对话、待发送要求和 Agent 临时状态，保留工作区文件、已安装脚本和模型设置。清空后无法恢复本段对话。"
        >
          <div className="form-actions">
            <Button disabled={clearing} onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button variant="danger" disabled={clearing} onClick={() => void clearConversation()}>
              {clearing
                ? '正在清空…'
                : snapshot &&
                    (running(snapshot) || snapshot.operations.some((op) => op.status === 'started'))
                  ? '停止并清空'
                  : '清空'}
            </Button>
          </div>
        </Modal>
        <Modal
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          title="会话历史"
          description="恢复文件和对话；中断的工具不会自动重放。"
          sheet
        >
          <Scroller className="history-list">
            {snapshot?.history.map((session) => (
              <button
                key={session.id}
                className={`history-item ${session.id === snapshot.session.id ? 'selected' : ''}`}
                disabled={clearing || running(snapshot)}
                onClick={() =>
                  void client
                    .call<Snapshot>('session.open', session.id)
                    .then((value) => {
                      setSnapshot(value);
                      setAttachment(undefined);
                      setHistoryOpen(false);
                    })
                    .catch(report)
                }
              >
                <strong>{session.title}</strong>
                <span>{session.targetUrl}</span>
                <time>{new Date(session.updatedAt).toLocaleString()}</time>
              </button>
            ))}
          </Scroller>
        </Modal>
      </div>
    </Tooltip.Provider>
  );
}
function ChatArea({
  client,
  snapshot,
  openFile,
  report,
  configure,
  attachment,
  clearAttachment,
  openWorkspace,
  host,
  configured,
}: {
  client: ControllerClient;
  snapshot: Snapshot;
  openFile: (path: string) => void;
  report: (error: unknown) => void;
  configure: () => void;
  attachment?: Attachment;
  clearAttachment: () => void;
  openWorkspace: () => void;
  host: string;
  configured: boolean;
}) {
  const conversationId = snapshot.session.conversationId ?? snapshot.session.id;
  const transport = useMemo(
    () => new ControllerChatTransport(client, conversationId),
    [client, conversationId],
  );
  const [input, setInput] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = 'auto';
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 200)}px`;
  }, [input]);
  const initialResume = useRef(running(snapshot)).current;
  const chat = useChat({
    id: conversationId,
    messages: snapshot.messages,
    transport,
    resume: initialResume,
    onError: report,
  });
  const busy = running(snapshot) || chat.status === 'submitted' || chat.status === 'streaming';
  useEffect(() => {
    if (!running(snapshot) && chat.status !== 'streaming' && chat.status !== 'submitted')
      chat.setMessages(snapshot.messages);
  }, [snapshot.messages, snapshot.run?.status, chat.status]);
  async function send(text = input) {
    if (!text.trim()) return;
    const content = attachment
      ? `${text.trim()}\n\n[显式附件：${attachment.path}${attachment.selection ? '，编辑器选区' : ''}]\n\`\`\`javascript\n${(attachment.selection || attachment.content).slice(0, 64000)}\n\`\`\``
      : text.trim();
    setInput('');
    clearAttachment();
    if (busy) await client.call('chat.queue', content);
    else await chat.sendMessage({ text: content });
  }
  return (
    <section className={`chat-pane ${chat.messages.length ? '' : 'is-empty'}`} aria-label="对话">
      <Conversation>
        {chat.messages.length ? (
          chat.messages.map((message) => (
            <ChatMessage key={message.id} message={message} client={client} openFile={openFile} />
          ))
        ) : (
          <div className="chat-empty">
            <h1>有什么可以帮你？</h1>
          </div>
        )}
      </Conversation>
      <div className="composer-area">
        {snapshot.run && (
          <div className={`run-status run-${snapshot.run.status}`} role="status">
            <span>{STATUS_LABELS[snapshot.run.status]}</span>
            {snapshot.run.status === 'limit_reached' && (
              <Button
                variant="ghost"
                onClick={() => void send('请继续完成任务，先检查现有状态。').catch(report)}
              >
                继续
              </Button>
            )}
          </div>
        )}
        {!!snapshot.run?.queued.length && (
          <div className="queue-list">
            <p className="eyebrow">{busy ? '步骤边界发送' : '尚未消费的补充要求'}</p>
            {snapshot.run.queued.map((text, index) => (
              <div key={index}>
                <span>{text.slice(0, 140)}</span>
                {!busy && <Button onClick={() => void send(text).catch(report)}>发送</Button>}
              </div>
            ))}
          </div>
        )}
        <form
          className="prompt-form"
          onSubmit={(event) => {
            event.preventDefault();
            void send().catch(report);
          }}
        >
          {attachment && (
            <div className="attachment-chip">
              <Paperclip size={12} />
              <span>
                {attachment.path.split('/').pop()}
                {attachment.selection ? ' · 选区' : ''}
              </span>
              <button type="button" onClick={clearAttachment} aria-label="移除附件">
                <X size={12} />
              </button>
            </div>
          )}
          <textarea
            ref={textarea}
            aria-label="发送给 Agent 的需求"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={busy ? '补充要求，将在步骤边界发送…' : '想为这个网页做些什么？'}
            rows={1}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send().catch(report);
              }
              if (event.key === 'Escape' && busy) {
                void client.call('stop');
                void chat.stop();
              }
            }}
          />
          <div className="prompt-actions">
            <IconButton label="添加文件" onClick={openWorkspace}>
              <Plus size={19} />
            </IconButton>
            <span className="prompt-context" title={snapshot.session.targetUrl}>
              <Globe2 size={12} />
              {host || '当前网页'}
            </span>
            {busy && (
              <Button
                variant="primary"
                className="send-button"
                aria-label="停止"
                onClick={() => {
                  void client.call('stop').catch(report);
                  void chat.stop();
                }}
              >
                <Square size={11} fill="currentColor" />
              </Button>
            )}
            {(!busy || input.trim()) && (
              <Button
                type="submit"
                variant="primary"
                className="send-button"
                disabled={!input.trim()}
                aria-label={busy ? '加入发送队列' : '发送消息'}
              >
                <ArrowUp size={18} />
              </Button>
            )}
          </div>
        </form>
        {!configured && (
          <button className="configure-hint" onClick={configure}>
            设置模型以开始对话
          </button>
        )}
      </div>
    </section>
  );
}
