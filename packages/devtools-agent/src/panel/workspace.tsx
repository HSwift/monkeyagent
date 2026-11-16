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
  files: 'Files',
  changes: 'Changes',
  debug: 'Debug',
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
              <IconButton label="Import Monkey script" onClick={() => openDialog('import')}>
                <Download size={14} />
              </IconButton>
              <IconButton label="New file" onClick={() => openDialog('new')}>
                <Plus size={15} />
              </IconButton>
            </>
          )}
          <Button
            ref={closeButton}
            variant="ghost"
            className="icon-button"
            aria-label="Close drawer"
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
            aria-label="Workspace files"
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
              <span>Workspace</span>
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
              {!snapshot.files.length && <p className="tree-empty">No files yet</p>}
            </Scroller>
          </aside>
          <div className="file-main">
            {file ? (
              <>
                <div className="file-toolbar">
                  <span className="file-path">{file.path}</span>
                  <IconButton label="Rename file" onClick={() => openDialog('rename')}>
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton label="Delete file" onClick={() => openDialog('delete')}>
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
                <h3>Start with a script</h3>
                <p>Ask the Agent to create a file, or import an existing script to edit.</p>
                <div className="inline-actions">
                  <Button onClick={() => openDialog('new')}>
                    <Plus size={14} />
                    New file
                  </Button>
                  <Button onClick={() => openDialog('import')}>
                    <Download size={14} />
                    Import script
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
          <div className="empty-workspace">Select a file to view changes</div>
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
            ? 'New workspace file'
            : dialog === 'rename'
              ? 'Rename file'
              : dialog === 'delete'
                ? 'Delete workspace file'
                : 'Import Monkey script'
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
              Installed scripts
              <select value={scriptId} onChange={(event) => setScriptId(event.target.value)}>
                {scripts.map((script) => (
                  <option key={script.id} value={script.id}>
                    {script.name}
                    {script.enabled ? '' : ' (disabled)'}
                  </option>
                ))}
              </select>
              {!scripts.length && (
                <span className="muted small">No scripts available to import.</span>
              )}
            </label>
          )}
          {dialog !== 'delete' ? (
            <label>
              File path
              <input
                autoFocus
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/workspace/main.user.js"
                required
              />
            </label>
          ) : (
            <p>Delete {file?.path} from the workspace. The installed Monkey script will be kept.</p>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              type="submit"
              variant={dialog === 'delete' ? 'danger' : 'primary'}
              disabled={busy || (dialog === 'import' && !scriptId)}
            >
              {busy ? 'Working…' : dialog === 'delete' ? 'Delete file' : 'Confirm'}
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
    ? 'Version conflict · Draft preserved'
    : saving
      ? 'Saving…'
      : dirty
        ? 'Unsaved changes'
        : !binding
          ? 'Saved · Not installed'
          : binding.fileRevision !== file.revision
            ? 'Saved · Modified since installation'
            : binding.verification
              ? binding.verification.passed
                ? 'Verification passed'
                : 'Verification failed'
              : 'Installed · Not verified';
  return (
    <>
      <div className="editor-container">
        <CodeEditor value={draft} onChange={setDraft} onSelection={setSelection} />{' '}
      </div>
      {conflict && (
        <div className="conflict-box">
          <strong>
            The file was updated by the Agent or another editor. Your draft has been preserved.
          </strong>
          <div className="inline-actions">
            <Button
              onClick={() => {
                setDraft(conflict.content);
                setBase(conflict);
                setConflict(undefined);
              }}
            >
              Use workspace version
            </Button>
            <Button onClick={() => void save(conflict.revision)}>Overwrite with this draft</Button>
          </div>
          <details>
            <summary>View the updated workspace content</summary>
            <pre>{conflict.content}</pre>
          </details>
        </div>
      )}
      <div className="file-status">
        <span className={`status-dot ${conflict ? 'warn' : ''}`} />
        <span>{status}</span>
        {externalChanged && (
          <span className="error-text">The script was changed outside the Agent in Monkey</span>
        )}
      </div>
      <div className="file-actions">
        <Button
          variant="primary"
          onClick={() => void install()}
          disabled={dirty || saving || !!conflict || installing || externalChanged}
        >
          <Download size={13} />
          {installing ? 'Installing…' : 'Install to Monkey'}
        </Button>
        <Button onClick={() => void verify().catch(report)} disabled={!binding}>
          <Play size={13} />
          Refresh and inspect
        </Button>
        <Button onClick={showDiff}>View diff</Button>
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
            {binding.enabled ? 'Disable' : 'Enable'}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => attach({ path: file.path, content: draft, selection })}
        >
          Attach {selection ? 'selection' : 'file'}
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
          aria-label="Diff baseline"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="task">Start of task</option>
          <option value="installed">Last installed version</option>
        </select>
        <Button
          onClick={() => void restore().catch(report)}
          disabled={!loaded || before === file.content}
        >
          <RotateCcw size={12} />
          Restore baseline
        </Button>
      </div>
      <div className="diff-labels">
        <span>Baseline</span>
        <span>Current workspace</span>
      </div>
      <DiffEditor before={before} after={file.content} />
      <p className="diff-note">
        Restoring creates a new file revision. Install it and refresh the page to update the running
        script.
      </p>
    </div>
  );
}
