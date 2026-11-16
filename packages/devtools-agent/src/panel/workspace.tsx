import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FolderOpen,
  Plus,
  Pencil,
  Trash2,
  Download,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';
import { Button, IconButton, Modal, Scroller } from '../components/ui';
import { CodeEditor, DiffEditor } from '../components/code-editor';
import type { ControllerClient } from '../protocol/client';
import type { FileRecord, ScriptSummary, Snapshot, ToolResult } from '../protocol/types';
import { DebugPane } from './debug';

type Attachment = { path: string; content: string; selection: string };
export type WorkspaceView = 'files' | 'changes' | 'debug';
const VIEW_LABELS: Record<WorkspaceView, string> = {
  files: '文件',
  changes: '变更',
  debug: '调试',
};
const editorDrafts = new Map<string, { draft: string; base: FileRecord; conflict?: FileRecord }>();
export function WorkspacePane({
  client,
  snapshot,
  selectedPath,
  selectFile,
  view,
  setView,
  open,
  close,
  attach,
  report,
}: {
  client: ControllerClient;
  snapshot: Snapshot;
  selectedPath: string;
  selectFile: (path: string) => void;
  view: WorkspaceView;
  setView: (view: WorkspaceView) => void;
  open: boolean;
  close: () => void;
  attach: (value: Attachment) => void;
  report: (error: unknown) => void;
}) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [dialog, setDialog] = useState<'new' | 'rename' | 'delete' | 'import' | null>(null);
  const [path, setPath] = useState('/workspace/main.user.js');
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [scriptId, setScriptId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The entrance animation starts offscreen; focusing must not scroll its parent.
    if (open) closeButton.current?.focus({ preventScroll: true });
  }, [open, view]);
  const file = snapshot.files.find((file) => file.path === selectedPath);
  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (dialog === 'new') {
        await client.call('files.write', path, '');
        selectFile(path);
      }
      if (dialog === 'rename' && file) {
        const renamed = await client.call<FileRecord>(
          'files.rename',
          file.path,
          path,
          file.revision,
        );
        const oldKey = `${snapshot.workspace.id}:${file.path}`;
        const draft = editorDrafts.get(oldKey);
        if (draft) {
          const conflicted = !!draft.conflict || draft.base.revision !== file.revision;
          editorDrafts.set(`${snapshot.workspace.id}:${renamed.path}`, {
            draft: draft.draft,
            base: { ...draft.base, path: renamed.path, revision: renamed.revision },
            conflict: conflicted ? renamed : undefined,
          });
          editorDrafts.delete(oldKey);
        }
        selectFile(renamed.path);
      }
      if (dialog === 'delete' && file) {
        await client.call('files.remove', file.path, file.revision);
        editorDrafts.delete(`${snapshot.workspace.id}:${file.path}`);
      }
      if (dialog === 'import') {
        const result = await client.call<ToolResult>('scripts.import', scriptId, path);
        if (!result.success) throw new Error(result.error?.message);
        selectFile(path);
      }
      setDialog(null);
      setView('files');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openDialog(value: typeof dialog) {
    setError('');
    setDialog(value);
    setPath(value === 'rename' ? selectedPath : '/workspace/main.user.js');
    if (value === 'import')
      client
        .call<ScriptSummary[]>('scripts.list')
        .then((value) => {
          setScripts(value);
          setScriptId(value[0]?.id ?? '');
        })
        .catch(report);
  }
  const groups = [
    ...new Set(snapshot.files.map((file) => file.path.slice(0, file.path.lastIndexOf('/')))),
  ].sort();
  return (
    <section className="workspace-pane">
      <div className="drawer-heading">
        <h2>{VIEW_LABELS[view]}</h2>
        <div className="toolbar-actions">
          {view === 'files' && (
            <>
              <IconButton label="导入 Monkey 脚本" onClick={() => openDialog('import')}>
                <Download size={14} />
              </IconButton>
              <IconButton label="新建文件" onClick={() => openDialog('new')}>
                <Plus size={15} />
              </IconButton>
            </>
          )}
          <Button
            ref={closeButton}
            variant="ghost"
            className="icon-button"
            aria-label="关闭抽屉"
            onClick={close}
          >
            <X size={16} />
          </Button>
        </div>
      </div>
      <div className="workspace-content" hidden={view !== 'files'}>
        <div className="file-layout">
          <aside
            className="file-tree"
            aria-label="工作区文件"
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              const files = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button.tree-file'),
              ];
              if (!files.length) return;
              const index = files.indexOf(event.target as HTMLButtonElement);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? files.length - 1
                    : Math.max(
                        0,
                        Math.min(files.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                      );
              event.preventDefault();
              files[next].click();
              files[next].focus();
            }}
          >
            <div className="tree-header">
              <span>工作区</span>
            </div>
            <Scroller>
              {groups.map((group) => (
                <div key={group}>
                  <button
                    className="tree-folder"
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        next.has(group) ? next.delete(group) : next.add(group);
                        return next;
                      })
                    }
                  >
                    {collapsed.has(group) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <FolderOpen size={13} />
                    {group.split('/').pop()}
                  </button>
                  {!collapsed.has(group) &&
                    snapshot.files
                      .filter((file) => file.path.slice(0, file.path.lastIndexOf('/')) === group)
                      .map((file) => (
                        <button
                          key={file.path}
                          className={`tree-file ${selectedPath === file.path ? 'selected' : ''}`}
                          onClick={() => selectFile(file.path)}
                          title={file.path}
                        >
                          <FileCode2 size={13} />
                          <span>{file.path.split('/').pop()}</span>
                          {snapshot.workspace.bindings[file.path]?.fileRevision !==
                            file.revision && <span className="file-dot" />}
                        </button>
                      ))}
                </div>
              ))}
              {!snapshot.files.length && <p className="tree-empty">还没有文件</p>}
            </Scroller>
          </aside>
          <div className="file-main">
            {file ? (
              <>
                <div className="file-toolbar">
                  <span className="file-path">{file.path}</span>
                  <IconButton label="重命名文件" onClick={() => openDialog('rename')}>
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton label="删除文件" onClick={() => openDialog('delete')}>
                    <Trash2 size={13} />
                  </IconButton>
                </div>
                <FileEditor
                  key={`${snapshot.workspace.id}:${file.path}`}
                  file={file}
                  snapshot={snapshot}
                  client={client}
                  report={report}
                  showDiff={() => setView('changes')}
                  attach={attach}
                />
              </>
            ) : (
              <div className="empty-workspace">
                <FileCode2 size={30} />
                <h3>从一个脚本开始</h3>
                <p>让 Agent 创建文件，或导入现有脚本继续修改。</p>
                <div className="inline-actions">
                  <Button onClick={() => openDialog('new')}>
                    <Plus size={14} />
                    新建文件
                  </Button>
                  <Button onClick={() => openDialog('import')}>
                    <Download size={14} />
                    导入脚本
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="workspace-content" hidden={view !== 'changes'}>
        {file ? (
          <Changes
            key={`${snapshot.session.id}:${file.path}`}
            client={client}
            file={file}
            snapshot={snapshot}
            report={report}
          />
        ) : (
          <div className="empty-workspace">选择一个文件查看变更</div>
        )}
      </div>
      <div className="workspace-content" hidden={view !== 'debug'}>
        <DebugPane client={client} snapshot={snapshot} report={report} />
      </div>
      <Modal
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={
          dialog === 'new'
            ? '新建工作区文件'
            : dialog === 'rename'
              ? '重命名文件'
              : dialog === 'delete'
                ? '删除工作区文件'
                : '导入 Monkey 脚本'
        }
      >
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {dialog === 'import' && (
            <label>
              已安装脚本
              <select value={scriptId} onChange={(event) => setScriptId(event.target.value)}>
                {scripts.map((script) => (
                  <option key={script.id} value={script.id}>
                    {script.name}
                    {script.enabled ? '' : '（已停用）'}
                  </option>
                ))}
              </select>
              {!scripts.length && <span className="muted small">还没有可导入的脚本。</span>}
            </label>
          )}
          {dialog !== 'delete' ? (
            <label>
              文件路径
              <input
                autoFocus
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/workspace/main.user.js"
                required
              />
            </label>
          ) : (
            <p>删除 {file?.path}。这只删除工作区文件；已安装的 Monkey 脚本仍然保留。</p>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <Button onClick={() => setDialog(null)}>取消</Button>
            <Button
              type="submit"
              variant={dialog === 'delete' ? 'danger' : 'primary'}
              disabled={busy || (dialog === 'import' && !scriptId)}
            >
              {busy ? '处理中…' : dialog === 'delete' ? '删除文件' : '确认'}
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}

function FileEditor({
  file,
  snapshot,
  client,
  report,
  showDiff,
  attach,
}: {
  file: FileRecord;
  snapshot: Snapshot;
  client: ControllerClient;
  report: (error: unknown) => void;
  showDiff: () => void;
  attach: (value: Attachment) => void;
}) {
  const cacheKey = `${snapshot.workspace.id}:${file.path}`;
  const cached = editorDrafts.get(cacheKey);
  const [draft, setDraft] = useState(cached?.draft ?? file.content);
  const [base, setBase] = useState(cached?.base ?? file);
  const [conflict, setConflict] = useState<FileRecord | undefined>(cached?.conflict);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState('');
  editorDrafts.set(cacheKey, { draft, base, conflict });
  const [installing, setInstalling] = useState(false);
  const [externalChanged, setExternalChanged] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baseRef = useRef(base);
  baseRef.current = base;
  const savingRef = useRef(false);
  const binding = snapshot.workspace.bindings[file.path];
  const dirty = draft !== base.content;
  useEffect(() => {
    if (file.revision === baseRef.current.revision || savingRef.current) return;
    if (draftRef.current !== baseRef.current.content) setConflict(file);
    else {
      setDraft(file.content);
      setBase(file);
      setConflict(undefined);
    }
  }, [file.revision]);
  async function save(expected = baseRef.current.revision) {
    if (savingRef.current) return;
    const content = draftRef.current;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await client.call<FileRecord>('files.write', file.path, content, expected);
      baseRef.current = saved;
      setBase(saved);
      setConflict(undefined);
    } catch (error) {
      if ((error as { code?: string }).code === 'conflict') {
        const remote = await client.call<FileRecord>('files.read', file.path);
        setConflict(remote);
      } else report(error);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  useEffect(() => {
    if (!dirty || conflict || saving) return;
    const timer = setTimeout(() => void save(), 600);
    return () => clearTimeout(timer);
  }, [draft, base.revision, conflict, saving]);
  useEffect(() => {
    if (!binding) {
      setExternalChanged(false);
      return;
    }
    client
      .call<{ externalChanged?: boolean }>('scripts.status', file.path)
      .then((value) => setExternalChanged(!!value.externalChanged))
      .catch(report);
  }, [binding?.scriptRevision, file.revision]);
  async function install() {
    if (dirty || saving || conflict) return;
    setInstalling(true);
    try {
      const result = await client.call<ToolResult>('scripts.apply', file.path);
      if (!result.success) throw new Error(result.error?.message);
    } catch (error) {
      report(error);
    } finally {
      setInstalling(false);
    }
  }
  async function verify() {
    const result = await client.call<ToolResult>(
      'repl.run',
      'await browser.reload({waitUntil:"domcontentloaded"}); return await browser.evaluate("({title:document.title,url:location.href})");',
    );
    if (!result.success) report(new Error(result.error?.message));
    // The refresh result is inspection only. A task-specific behavior assertion is still required.
  }
  const status = conflict
    ? '版本冲突，草稿已保留'
    : saving
      ? '正在保存…'
      : dirty
        ? '有未保存修改'
        : !binding
          ? '已保存 · 尚未安装'
          : binding.fileRevision !== file.revision
            ? '已保存 · 安装后有修改'
            : binding.verification
              ? binding.verification.passed
                ? '验证通过'
                : '验证失败'
              : '已安装 · 待验证';
  return (
    <>
      <div className="editor-container">
        <CodeEditor value={draft} onChange={setDraft} onSelection={setSelection} />{' '}
      </div>
      {conflict && (
        <div className="conflict-box">
          <strong>Agent 或另一处编辑更新了文件，当前草稿仍保留。</strong>
          <div className="inline-actions">
            <Button
              onClick={() => {
                setDraft(conflict.content);
                setBase(conflict);
                setConflict(undefined);
              }}
            >
              使用工作区版本
            </Button>
            <Button onClick={() => void save(conflict.revision)}>用当前草稿覆盖新版本</Button>
          </div>
          <details>
            <summary>查看工作区的新内容</summary>
            <pre>{conflict.content}</pre>
          </details>
        </div>
      )}
      <div className="file-status">
        <span className={`status-dot ${conflict ? 'warn' : ''}`} />
        <span>{status}</span>
        {externalChanged && <span className="error-text">Monkey 中的脚本已被外部修改</span>}
      </div>
      <div className="file-actions">
        <Button
          variant="primary"
          onClick={() => void install()}
          disabled={dirty || saving || !!conflict || installing || externalChanged}
        >
          <Download size={13} />
          {installing ? '安装中…' : '安装到 Monkey'}
        </Button>
        <Button onClick={() => void verify().catch(report)} disabled={!binding}>
          <Play size={13} />
          刷新并检查
        </Button>
        <Button onClick={showDiff}>查看差异</Button>
        {binding && (
          <Button
            onClick={() =>
              void client
                .call<ToolResult>('scripts.setEnabled', file.path, !binding.enabled)
                .then((result) => {
                  if (!result.success) throw new Error(result.error?.message);
                })
                .catch(report)
            }
          >
            {binding.enabled ? '停用' : '启用'}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => attach({ path: file.path, content: draft, selection })}
        >
          附加{selection ? '选区' : '文件'}
        </Button>
      </div>
    </>
  );
}
function Changes({
  client,
  file,
  snapshot,
  report,
}: {
  client: ControllerClient;
  file: FileRecord;
  snapshot: Snapshot;
  report: (error: unknown) => void;
}) {
  const [mode, setMode] = useState('task');
  const [before, setBefore] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    client
      .call<string>('files.baseline', file.path, mode)
      .then((value) => {
        if (cancelled) return;
        setBefore(value);
        setLoaded(true);
      })
      .catch(report);
    return () => {
      cancelled = true;
    };
  }, [
    file.path,
    mode,
    snapshot.workspace.id,
    snapshot.session.id,
    snapshot.session.baseline[file.path],
    snapshot.workspace.bindings[file.path]?.fileRevision,
  ]);
  async function restore() {
    await client.call('files.write', file.path, before, file.revision);
  }
  return (
    <div className="changes-pane">
      <div className="file-toolbar">
        <span className="file-path">{file.path}</span>
        <select
          aria-label="差异基线"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="task">本轮任务开始时</option>
          <option value="installed">最近安装版本</option>
        </select>
        <Button
          onClick={() => void restore().catch(report)}
          disabled={!loaded || before === file.content}
        >
          <RotateCcw size={12} />
          恢复基线
        </Button>
      </div>
      <div className="diff-labels">
        <span>基线</span>
        <span>当前工作区</span>
      </div>
      <DiffEditor before={before} after={file.content} />
      <p className="diff-note">恢复会创建新的文件修订。要更新网页运行的脚本，请再次安装并刷新。</p>
    </div>
  );
}
