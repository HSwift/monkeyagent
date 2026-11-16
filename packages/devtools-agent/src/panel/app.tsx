import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  Bot,
  Plus,
  History,
  Settings2,
  ArrowUp,
  Square,
  Paperclip,
  X,
  Globe2,
  PanelRightOpen,
  MessageSquare,
  Sparkles,
  AlertCircle,
  RotateCcw,
} from 'lucide-react';
import { Button, IconButton, Modal, Scroller, Tooltip } from '../components/ui';
import { Conversation, ChatMessage } from '../components/conversation';
import { ControllerChatTransport, type ControllerClient } from '../protocol/client';
import type { ModelSettings, Snapshot } from '../protocol/types';
import { Settings } from './settings';
const WorkspacePane = lazy(() =>
  import('./workspace').then((module) => ({ default: module.WorkspacePane })),
);

type Attachment = { path: string; content: string; selection: string };
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
  const [workspaceTab, setWorkspaceTab] = useState('files');
  const [mobileTab, setMobileTab] = useState('chat');
  const [narrow, setNarrow] = useState(false);
  const [attachment, setAttachment] = useState<Attachment>();
  const root = useRef<HTMLDivElement>(null);
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
    const observer = new ResizeObserver((entries) => setNarrow(entries[0].contentRect.width < 720));
    if (root.current) observer.observe(root.current);
    return () => {
      unsubscribe();
      observer.disconnect();
    };
  }, []);
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
    if (
      snapshot &&
      !snapshot.files.some((file) => file.path === selectedPath) &&
      snapshot.files.length
    )
      setSelectedPath(snapshot.files[0].path);
  }, [snapshot?.files.map((file) => file.path).join('|')]);
  async function newSession() {
    const value = await client.call<Snapshot>('workspace.new');
    setSnapshot(value);
    setAttachment(undefined);
    setMobileTab('chat');
  }
  async function clearConversation() {
    setClearing(true);
    try {
      const value = await client.call<Snapshot>('chat.clear');
      setSnapshot(value);
      setError('');
      setAttachment(undefined);
      setMobileTab('chat');
      setClearOpen(false);
    } catch (error) {
      report(error);
    } finally {
      setClearing(false);
    }
  }
  function openFile(path: string) {
    setSelectedPath(path);
    setWorkspaceTab('changes');
    setMobileTab('workspace');
  }
  let host = '';
  try {
    host = new URL(snapshot?.workspace.targetUrl ?? '').host;
  } catch {}
  return (
    <Tooltip.Provider delayDuration={300}>
      <div ref={root} className="app">
        <header className="app-header">
          <div className="brand">
            <span className="brand-icon">
              <Bot size={19} />
            </span>
            <strong>Agent</strong>
            <span className="brand-caption">MONKEY</span>
          </div>
          <div className="target-pill" title={snapshot?.workspace.targetUrl}>
            <Globe2 size={12} />
            <span>{host || '当前网页'}</span>
          </div>
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
            <button
              className="model-select"
              onClick={() => setSettingsOpen(true)}
              title="选择和配置模型"
            >
              <span className="model-dot" />
              {model}
            </button>
            <IconButton
              label="新会话"
              disabled={clearing || (!!snapshot && running(snapshot))}
              onClick={() => void newSession().catch(report)}
            >
              <Plus size={16} />
            </IconButton>
            <IconButton label="会话历史" onClick={() => setHistoryOpen(true)}>
              <History size={16} />
            </IconButton>
            <IconButton label="模型设置" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={16} />
            </IconButton>
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
        {narrow && (
          <nav className="mobile-tabs">
            <Button
              variant={mobileTab === 'chat' ? 'default' : 'ghost'}
              onClick={() => setMobileTab('chat')}
            >
              <MessageSquare size={13} />
              对话
            </Button>
            <Button
              variant={mobileTab === 'workspace' ? 'default' : 'ghost'}
              onClick={() => setMobileTab('workspace')}
            >
              <PanelRightOpen size={13} />
              工作区
            </Button>
          </nav>
        )}
        {snapshot ? (
          <Group
            className={`main-layout ${narrow ? 'narrow' : ''}`}
            orientation="horizontal"
            disabled={narrow}
          >
            <Panel
              id="chat"
              defaultSize="40%"
              minSize={narrow ? 0 : '280px'}
              className={`resize-panel ${narrow && mobileTab !== 'chat' ? 'hidden' : ''}`}
            >
              <ChatArea
                key={snapshot.workspace.conversationId ?? snapshot.workspace.id}
                client={client}
                snapshot={snapshot}
                openFile={openFile}
                report={report}
                configure={() => setSettingsOpen(true)}
                attachment={attachment}
                clearAttachment={() => setAttachment(undefined)}
                clearConversation={() => setClearOpen(true)}
                clearing={clearing}
              />
            </Panel>
            <Separator className={`resize-handle ${narrow ? 'hidden' : ''}`} />
            <Panel
              id="workspace"
              defaultSize="60%"
              minSize={narrow ? 0 : '320px'}
              className={`resize-panel ${narrow && mobileTab !== 'workspace' ? 'hidden' : ''}`}
            >
              <Suspense fallback={<div className="loading-app">正在打开工作区…</div>}>
                <WorkspacePane
                  client={client}
                  snapshot={snapshot}
                  selectedPath={selectedPath}
                  selectFile={setSelectedPath}
                  activeTab={workspaceTab}
                  setActiveTab={setWorkspaceTab}
                  report={report}
                  attach={(attachment) => {
                    setAttachment(attachment);
                    setMobileTab('chat');
                  }}
                />
              </Suspense>
            </Panel>
          </Group>
        ) : (
          <div className="loading-app">
            <Bot size={28} />
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
            {snapshot?.history.map((workspace) => (
              <button
                key={workspace.id}
                className={`history-item ${workspace.id === snapshot.workspace.id ? 'selected' : ''}`}
                disabled={clearing || running(snapshot)}
                onClick={() =>
                  void client
                    .call<Snapshot>('workspace.open', workspace.id)
                    .then((value) => {
                      setSnapshot(value);
                      setAttachment(undefined);
                      setHistoryOpen(false);
                    })
                    .catch(report)
                }
              >
                <strong>{workspace.title}</strong>
                <span>{workspace.targetUrl}</span>
                <time>{new Date(workspace.updatedAt).toLocaleString()}</time>
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
  clearConversation,
  clearing,
}: {
  client: ControllerClient;
  snapshot: Snapshot;
  openFile: (path: string) => void;
  report: (error: unknown) => void;
  configure: () => void;
  attachment?: Attachment;
  clearAttachment: () => void;
  clearConversation: () => void;
  clearing: boolean;
}) {
  const conversationId = snapshot.workspace.conversationId ?? snapshot.workspace.id;
  const transport = useMemo(
    () => new ControllerChatTransport(client, conversationId),
    [client, conversationId],
  );
  const [input, setInput] = useState('');
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
  const suggestions = ['为当前网页编写脚本', '修改已有脚本', '检查脚本报错'];
  return (
    <section className="chat-pane">
      <div className="chat-heading">
        <span>对话</span>
        <span className="muted chat-title">
          {snapshot.messages.length
            ? snapshot.workspace.title.slice(0, 28)
            : '当前网页的脚本工作台'}
        </span>
        <Button variant="ghost" disabled={clearing} onClick={clearConversation}>
          <RotateCcw size={12} />
          清空上下文
        </Button>
      </div>
      <Conversation>
        {chat.messages.length ? (
          chat.messages.map((message) => (
            <ChatMessage key={message.id} message={message} client={client} openFile={openFile} />
          ))
        ) : (
          <div className="chat-empty">
            <div className="empty-icon">
              <Sparkles size={24} />
            </div>
            <p className="eyebrow">BUILD FOR THIS PAGE</p>
            <h1>
              把想法变成
              <br />
              网页上的改变。
            </h1>
            <p>
              描述你想做的事。Agent 可以编写脚本，
              <br />
              安装到 Monkey，并在当前网页验证。
            </p>
            <div className="suggestions">
              {suggestions.map((text, index) => (
                <button
                  key={text}
                  onClick={() => {
                    if (index === 1) setInput('我想修改已有脚本，请先列出已安装脚本。');
                    else if (index === 2) setInput('请连接当前网页，检查脚本报错并分析原因。');
                    else setInput('请先检查当前网页，帮我编写一个脚本：');
                  }}
                >
                  <span>{text}</span>
                  <ArrowUp size={13} />
                </button>
              ))}
            </div>
            <Button variant="ghost" className="configure-hint" onClick={configure}>
              首次使用，先配置模型 API
            </Button>
          </div>
        )}
      </Conversation>
      {snapshot.run && (
        <div className={`run-status run-${snapshot.run.status}`}>
          <span className={`status-dot ${busy ? 'pulse' : ''}`} />
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
          aria-label="发送给 Agent 的需求"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={busy ? '补充要求，将在步骤边界发送…' : '想为这个网页做些什么？'}
          rows={3}
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
          <span>Enter 发送 · Shift Enter 换行</span>
          {busy && (
            <Button
              variant="danger"
              onClick={() => {
                void client.call('stop').catch(report);
                void chat.stop();
              }}
            >
              <Square size={11} fill="currentColor" />
              停止
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={!input.trim()}
            aria-label={busy ? '加入发送队列' : '发送消息'}
          >
            <ArrowUp size={15} />
            {busy ? '排队' : '发送'}
          </Button>
        </div>
      </form>
      <div className="chat-footer">操作目标始终是当前被检查的网页</div>
    </section>
  );
}
