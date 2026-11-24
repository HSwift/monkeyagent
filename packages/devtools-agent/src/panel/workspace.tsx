import { useEffect, useRef, useState } from 'react';
import {
  FileCode2,
  Plus,
  Pencil,
  Trash2,
  Download,
  Upload,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';
import { Button, IconButton, Modal } from '../components/ui';
import { CodeEditor, DiffEditor } from '../components/code-editor';
import type { ControllerClient } from '../protocol/client';
import type {
  FileRecord,
  ScriptSummary,
  ScriptVersionInfo,
  Snapshot,
  ToolResult,
} from '../protocol/types';
import { DebugPane } from './debug';
import { ReadonlyFileViewer } from './artifact';
import { FileTree } from './file-tree';
type Attachment = { path: string; content: string; selection: string };
type EditorDraftStatus = { path: string; revision: string; pending: boolean };
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
  const [dialog, setDialog] = useState<'new' | 'rename' | 'delete' | 'import' | null>(null);
  const [path, setPath] = useState('/workspace/main.user.js');
  const [upload, setUpload] = useState<File | null>(null);
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [scriptId, setScriptId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draftStatus, setDraftStatus] = useState<EditorDraftStatus>();
  const closeButton = useRef<HTMLButtonElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
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
        let content = '';
        if (upload) {
          if (upload.size > 2 * 1024 * 1024) throw new Error('Text files are limited to 2 MiB.');
          const data = await upload.arrayBuffer();
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(data);
          } catch {
            throw new Error('Choose a UTF-8 text file. Binary files are not supported.');
          }
          if (content.includes('\0'))
            throw new Error('Choose a UTF-8 text file. Binary files are not supported.');
        }
        const created = await client.call<FileRecord>('files.write', path, content);
        selectFile(created.path);
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
      setError(
        dialog === 'new' && (error as { code?: string }).code === 'conflict'
          ? 'A file already exists at this path. Choose a different file path.'
          : (error as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  function openDialog(value: typeof dialog) {
    setError('');
    setDialog(value);
    setUpload(null);
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
          <FileTree
            client={client}
            snapshot={snapshot}
            active={open && view === 'files'}
            selectedPath={selectedPath}
            selectFile={selectFile}
          />
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
                  onDraftStatus={setDraftStatus}
                  showDiff={() => setView('changes')}
                  attach={attach}
                />
              </>
            ) : selectedPath.startsWith('/artifacts/') || selectedPath.startsWith('/docs/') ? (
              <ReadonlyFileViewer
                key={`${snapshot.workspace.id}:${selectedPath}`}
                path={selectedPath}
                client={client}
              />
            ) : (
              <div className="empty-workspace">
                <FileCode2 size={30} />
                <h3>Start with a script</h3>
                <p>
                  Ask the Agent to create a file, upload a local file, or import an existing script.
                </p>
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
        {view === 'changes' && (
          <Changes
            client={client}
            snapshot={snapshot}
            report={report}
            draftStatus={draftStatus}
            selectedPath={selectedPath}
            selectFile={selectFile}
          />
        )}
      </div>
      <div className="workspace-content" hidden={view !== 'debug'}>
        <DebugPane client={client} snapshot={snapshot} report={report} />
      </div>
      <Modal
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
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
                disabled={busy}
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
            <Button onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={dialog === 'delete' ? 'danger' : 'primary'}
              disabled={busy || (dialog === 'import' && !scriptId)}
            >
              {busy
                ? 'Working…'
                : dialog === 'delete'
                  ? 'Delete file'
                  : dialog === 'new' && upload
                    ? 'Upload'
                    : 'Confirm'}
            </Button>
          </div>
          {dialog === 'new' && (
            <div className="file-upload">
              <input
                ref={uploadInput}
                type="file"
                aria-label="Local file"
                hidden
                disabled={busy}
                onChange={(event) => {
                  const selected = event.target.files?.[0];
                  if (!selected) return;
                  setUpload(selected);
                  setPath(`/workspace/${selected.name}`);
                  setError('');
                  event.target.value = '';
                }}
              />
              <Button onClick={() => uploadInput.current?.click()} disabled={busy}>
                <Upload size={14} />
                Upload file
              </Button>
              {upload && <span className="small">{upload.name}</span>}
              <span className="muted small">UTF-8 text files up to 2 MiB.</span>
            </div>
          )}
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
  onDraftStatus,
}: {
  file: FileRecord;
  snapshot: Snapshot;
  client: ControllerClient;
  report: (error: unknown) => void;
  showDiff: () => void;
  attach: (value: Attachment) => void;
  onDraftStatus: (status: EditorDraftStatus) => void;
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
    onDraftStatus({
      path: file.path,
      revision: base.revision,
      pending: dirty || !!conflict || saving,
    });
  }, [file.path, base.revision, dirty, conflict, saving, onDraftStatus]);
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
        {binding && <Button onClick={showDiff}>Script changes</Button>}
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
  snapshot,
  report,
  draftStatus,
  selectedPath,
  selectFile,
}: {
  client: ControllerClient;
  snapshot: Snapshot;
  report: (error: unknown) => void;
  draftStatus?: EditorDraftStatus;
  selectedPath: string;
  selectFile: (path: string) => void;
}) {
  const paths = Object.keys(snapshot.workspace.bindings).filter((path) =>
    snapshot.files.some((file) => file.path === path),
  );
  const path = paths.includes(selectedPath) ? selectedPath : paths[0];
  const file = snapshot.files.find((file) => file.path === path);
  const binding = snapshot.workspace.bindings[path];
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState({ scriptId: '', versionId: 'current' });
  const selected = selection.scriptId === binding?.scriptId ? selection.versionId : 'current';
  const key = JSON.stringify([
    snapshot.workspace.id,
    binding?.scriptId,
    binding?.scriptRevision,
    refresh,
  ]);
  const [history, setHistory] = useState<{
    key: string;
    name: string;
    revision: string;
    versions: ScriptVersionInfo[];
  }>();
  const [baseline, setBaseline] = useState<{ key: string; code: string }>();
  const [loading, setLoading] = useState(false);
  const codeKey = JSON.stringify([key, selected]);
  useEffect(() => {
    if (path && path !== selectedPath) selectFile(path);
  }, [path, selectedPath, selectFile]);
  useEffect(() => {
    let cancelled = false;
    if (!binding) return;
    setLoading(true);
    client
      .call<{ script: ScriptSummary & { revision: string }; versions: ScriptVersionInfo[] }>(
        'scripts.history',
        path,
      )
      .then((result) => {
        if (!cancelled) {
          setHistory({
            key,
            name: result.script.name,
            revision: result.script.revision,
            versions: result.versions,
          });
          if (selected !== 'current' && !result.versions.some((version) => version.id === selected))
            setSelection({ scriptId: binding.scriptId, versionId: 'current' });
        }
      })
      .catch((error) => {
        if (!cancelled) report(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, client, path]);
  useEffect(() => {
    let cancelled = false;
    if (!binding || history?.key !== key) return;
    client
      .call<{ code: string }>('scripts.version', path, selected)
      .then((result) => {
        if (!cancelled) setBaseline({ key: codeKey, code: result.code });
      })
      .catch((error) => {
        if (!cancelled) report(error);
      });
    return () => {
      cancelled = true;
    };
  }, [codeKey, history, client, path]);
  if (!file || !binding)
    return (
      <div className="empty-workspace">
        <h3>No installed userscript selected</h3>
        <p>
          Install or import a userscript to compare its saved versions with its working draft.
          Ordinary workspace files have no version history.
        </p>
      </div>
    );
  const loaded = history?.key === key && baseline?.key === codeKey;
  const pendingDraft =
    draftStatus?.path === path && (draftStatus.pending || draftStatus.revision !== file.revision);
  const before = loaded ? baseline.code : '';
  async function restore() {
    if (!loaded || pendingDraft) return;
    await client.call('scripts.restore', file!.path, selected, file!.revision, history!.revision);
  }
  return (
    <div className="changes-pane">
      <div className="file-toolbar">
        <label>
          Userscript{' '}
          <select
            aria-label="Userscript"
            value={path}
            onChange={(event) => selectFile(event.target.value)}
          >
            {paths.map((path) => (
              <option key={path} value={path}>
                {path.split('/').pop()}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => setRefresh((value) => value + 1)} disabled={loading}>
          <RotateCcw size={12} /> Refresh history
        </Button>
      </div>
      <div className="file-toolbar">
        <span className="file-path">
          {history?.key === key ? history.name : 'Loading userscript…'}
        </span>
        <select
          aria-label="Script version"
          value={selected}
          disabled={history?.key !== key}
          onChange={(event) =>
            setSelection({ scriptId: binding.scriptId, versionId: event.target.value })
          }
        >
          <option value="current">Latest installed version</option>
          {history?.key === key &&
            history.versions.map((version) => (
              <option key={version.id} value={version.id}>
                {new Date(version.createdAt).toLocaleString('en-US')} ·{' '}
                {version.version || 'No @version'} · {version.source} · {version.id.slice(0, 8)}
              </option>
            ))}
        </select>
        <Button
          onClick={() => void restore().catch(report)}
          disabled={!loaded || pendingDraft || before === file.content}
          title={
            pendingDraft
              ? 'Wait for the draft to save, or resolve its conflict in Files.'
              : undefined
          }
        >
          Restore to editor
        </Button>
      </div>
      <div className="diff-labels">
        <span>Saved script version</span>
        <span>Working script draft</span>
      </div>
      {loaded ? (
        <DiffEditor before={before} after={file.content} />
      ) : (
        <p className="muted small">Loading script version…</p>
      )}
      <p className="diff-note">
        History belongs to this installed userscript. Restore loads a version into its draft;
        install to Monkey and reload the page to apply it. Only changed script saves create
        versions; the latest 20 are kept.
      </p>
    </div>
  );
}
