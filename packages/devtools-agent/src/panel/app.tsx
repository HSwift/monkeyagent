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
import { injectionMessage, interleave } from '../agent/interleave';
import { ControllerChatTransport, type ControllerClient } from '../protocol/client';
import type { ModelSettings, Snapshot } from '../protocol/types';
import { Settings } from './settings';
import type { WorkspaceView } from './workspace';
const WorkspacePane = lazy(() =>
  import('./workspace').then((module) => ({ default: module.WorkspacePane })),
);

type Attachment = { path: string; content: string; selection: string };
const DRAWERS: { view: WorkspaceView; label: string }[] = [
  { view: 'files', label: 'Files' },
  { view: 'changes', label: 'Changes' },
  { view: 'debug', label: 'Debug' },
];
const STATUS_LABELS: Record<string, string> = {
  idle: 'Ready',
  generating: 'Generating',
  executing: 'Running tools',
  stopping: 'Stopping…',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  limit_reached: 'Step limit reached',
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
  const [model, setModel] = useState('Configure model');
  const [selectedPath, setSelectedPath] = useState('/workspace/main.user.js');
  const [drawerView, setDrawerView] = useState<WorkspaceView>('files');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTriggers = useRef<Partial<Record<WorkspaceView, HTMLButtonElement | null>>>({});
  const [attachment, setAttachment] = useState<Attachment>();
  function report(error: unknown) {
    setError(error instanceof Error ? error.message : String(error));
  }
  function applySettings(settings: ModelSettings) {
    setModel(settings.model || 'Configure model');
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
    openDrawer('files');
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
            aria-label="Model settings"
            title="Choose and configure a model"
          >
            <strong>Agent</strong>
            {model !== 'Configure model' && <span>{model}</span>}
            <ChevronDown size={14} />
          </button>
          <div className="header-actions">
            {snapshot &&
              (running(snapshot) ||
                snapshot.operations.some((operation) => operation.status === 'started')) && (
                <IconButton
                  label="Stop current run (Ctrl/⌘ .)"
                  onClick={() => void client.call('stop').catch(report)}
                >
                  <Square size={13} />
                </IconButton>
              )}
            <IconButton
              label="New session"
              disabled={clearing || (!!snapshot && running(snapshot))}
              onClick={() => void newSession().catch(report)}
            >
              <SquarePen size={17} />
            </IconButton>
            <nav className="drawer-actions" aria-label="Tools">
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
                <button className="button button-ghost icon-button" aria-label="More actions">
                  <MoreHorizontal size={18} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="action-menu" align="end" sideOffset={8}>
                  <DropdownMenu.Item onSelect={() => setHistoryOpen(true)}>
                    <History size={15} />
                    Session history
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => setSettingsOpen(true)}>
                    <Settings2 size={15} />
                    Model settings
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item disabled={clearing} onSelect={() => setClearOpen(true)}>
                    <RotateCcw size={15} />
                    Clear context
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
              aria-label="Dismiss error"
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
                configured={model !== 'Configure model'}
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
              aria-label={`${DRAWERS.find(({ view }) => view === drawerView)?.label} drawer`}
              hidden={!drawerOpen}
            >
              <Suspense fallback={<div className="loading-app">Opening…</div>}>
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
            <p>Connecting to DevTools…</p>
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
          title="Clear conversation context"
          description="Clear messages, queued instructions, and temporary Agent state. Keep workspace files, installed scripts, and model settings. This conversation cannot be recovered after clearing."
        >
          <div className="form-actions">
            <Button disabled={clearing} onClick={() => setClearOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={clearing} onClick={() => void clearConversation()}>
              {clearing
                ? 'Clearing…'
                : snapshot &&
                    (running(snapshot) || snapshot.operations.some((op) => op.status === 'started'))
                  ? 'Stop and clear'
                  : 'Clear'}
            </Button>
          </div>
        </Modal>
        <Modal
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          title="Session history"
          description="Open a session in this site workspace. Interrupted tools will not run again automatically."
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
                <time>{new Date(session.updatedAt).toLocaleString('en-US')}</time>
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
  const injected = snapshot.run?.injected;
  // The live stream is one assistant message; place consumed queued messages where the agent
  // received them, as the controller does when it persists the conversation.
  const displayed = useMemo(() => {
    const pending = (injected ?? []).filter(
      (injection) => !chat.messages.some((message) => message.id === injection.id),
    );
    if (!pending.length) return chat.messages;
    const last = chat.messages.at(-1);
    return last?.role === 'assistant'
      ? [...chat.messages.slice(0, -1), ...interleave(last, pending)]
      : [...chat.messages, ...pending.map(injectionMessage)];
  }, [chat.messages, injected]);
  useEffect(() => {
    if (!running(snapshot) && chat.status !== 'streaming' && chat.status !== 'submitted')
      chat.setMessages(snapshot.messages);
  }, [snapshot.messages, snapshot.run?.status, chat.status]);
  async function send(text = input) {
    if (!text.trim()) return;
    const content = attachment
      ? `${text.trim()}\n\n[Attached file: ${attachment.path}${attachment.selection ? ', editor selection' : ''}]\n\`\`\`javascript\n${(attachment.selection || attachment.content).slice(0, 64000)}\n\`\`\``
      : text.trim();
    setInput('');
    clearAttachment();
    if (busy) await client.call('chat.queue', content);
    else await chat.sendMessage({ text: content });
  }
  return (
    <section
      className={`chat-pane ${displayed.length ? '' : 'is-empty'}`}
      aria-label="Conversation"
    >
      <Conversation>
        {displayed.length ? (
          displayed.map((message, index) => (
            <ChatMessage
              key={message.id}
              message={message}
              client={client}
              openFile={openFile}
              streaming={busy && message.role === 'assistant' && index === displayed.length - 1}
            />
          ))
        ) : (
          <div className="chat-empty">
            <h1>How can I help?</h1>
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
                onClick={() =>
                  void send('Continue the task. Check the current state first.').catch(report)
                }
              >
                Continue
              </Button>
            )}
          </div>
        )}
        {!!snapshot.run?.queued.length && (
          <div className="queue-list">
            <p className="eyebrow">{busy ? 'Queued for the next step' : 'Pending instructions'}</p>
            {snapshot.run.queued.map((text, index) => (
              <div key={index}>
                <span>{text.slice(0, 140)}</span>
                {!busy && <Button onClick={() => void send(text).catch(report)}>Send</Button>}
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
                {attachment.selection ? ' · selection' : ''}
              </span>
              <button type="button" onClick={clearAttachment} aria-label="Remove attachment">
                <X size={12} />
              </button>
            </div>
          )}
          <textarea
            ref={textarea}
            aria-label="Message Agent"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={
              busy
                ? 'Add instructions for the next step…'
                : 'What would you like to do with this page?'
            }
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
            <IconButton label="Add file" onClick={openWorkspace}>
              <Plus size={19} />
            </IconButton>
            <span className="prompt-context" title={snapshot.session.targetUrl}>
              <Globe2 size={12} />
              {host || 'Current page'}
            </span>
            {busy && (
              <Button
                variant="primary"
                className="send-button"
                aria-label="Stop"
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
                aria-label={busy ? 'Queue message' : 'Send message'}
              >
                <ArrowUp size={18} />
              </Button>
            )}
          </div>
        </form>
        {!configured && (
          <button className="configure-hint" onClick={configure}>
            Configure a model to start chatting
          </button>
        )}
      </div>
    </section>
  );
}
