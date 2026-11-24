import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FolderOpen,
  LockKeyhole,
  RotateCcw,
} from 'lucide-react';
import { Scroller } from '../components/ui';
import type { ControllerClient } from '../protocol/client';
import type { Snapshot } from '../protocol/types';

type Entry = { path: string; revision: string; size: number; updatedAt: number };
type Node = { path: string; children: Map<string, Node>; file?: Entry };
function directories(path: string) {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, index) => '/' + parts.slice(0, index + 1).join('/'));
}
function TreeRoot({
  root,
  files,
  expanded,
  toggle,
  selectedPath,
  selectFile,
  bindings,
  children,
}: {
  root: string;
  files: Entry[];
  expanded: Set<string>;
  toggle: (path: string) => void;
  selectedPath: string;
  selectFile: (path: string) => void;
  bindings: Snapshot['workspace']['bindings'];
  children?: React.ReactNode;
}) {
  const tree = useMemo(() => {
    const base: Node = { path: root, children: new Map() };
    for (const entry of files) {
      if (!entry.path.startsWith(root + '/')) continue;
      const parts = entry.path.slice(root.length + 1).split('/');
      let node = base;
      for (const [index, part] of parts.entries()) {
        const key = (index === parts.length - 1 ? 'file:' : 'directory:') + part;
        let next = node.children.get(key);
        if (!next) {
          next = { path: node.path + '/' + part, children: new Map() };
          node.children.set(key, next);
        }
        node = next;
      }
      node.file = entry;
    }
    return base;
  }, [files, root]);
  const readonly = root !== '/workspace';
  function render(node: Node, depth: number): React.ReactNode {
    if (node.file)
      return (
        <button
          key={node.path + ':file'}
          className={'tree-file' + (selectedPath === node.path ? ' selected' : '')}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => selectFile(node.path)}
          title={node.path}
        >
          <FileCode2 size={13} />
          <span>{node.path.split('/').pop()}</span>
          {!readonly && bindings[node.path]?.fileRevision !== node.file.revision && (
            <span className="file-dot" />
          )}
        </button>
      );
    const open = expanded.has(node.path);
    return (
      <div key={node.path + ':directory'}>
        <button
          className="tree-folder"
          aria-label={node.path}
          aria-expanded={open}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => toggle(node.path)}
          title={node.path + (readonly ? ' (read-only)' : '')}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <FolderOpen size={13} />
          <span>{depth === 0 ? node.path : node.path.split('/').pop()}</span>
          {readonly && depth === 0 && <LockKeyhole size={11} />}
        </button>
        {open && (
          <>
            {depth === 0 && children}
            {[...node.children.values()]
              .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.path.localeCompare(b.path))
              .map((child) => render(child, depth + 1))}
            {!node.children.size && !children && <p className="tree-empty">No files yet</p>}
          </>
        )}
      </div>
    );
  }
  return render(tree, 0);
}

function VirtualRoot({
  root,
  revision,
  client,
  active,
  ...treeProps
}: {
  root: '/docs' | '/artifacts';
  revision: string;
  client: ControllerClient;
  active: boolean;
} & Omit<Parameters<typeof TreeRoot>[0], 'root' | 'files' | 'children'>) {
  const [refresh, setRefresh] = useState(0);
  const key = JSON.stringify([root, revision, refresh]);
  const [listing, setListing] = useState<{ key: string; files?: Entry[]; error?: string }>();
  const open = treeProps.expanded.has(root);
  useEffect(() => {
    if (!active || !open || (listing?.key === key && listing.files)) return;
    let cancelled = false;
    client.call<Entry[]>('files.list', root).then(
      (files) => {
        if (!cancelled) setListing({ key, files });
      },
      (error) => {
        if (!cancelled)
          setListing({ key, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, open, key, client, root]);
  const files = listing?.key === key ? listing.files : undefined;
  return (
    <TreeRoot root={root} files={files ?? []} {...treeProps}>
      {!files ? (
        <div className="tree-empty">
          {listing?.key === key && listing.error ? (
            <>
              <span role="alert">{listing.error}</span>
              <button onClick={() => setRefresh((value) => value + 1)}>Retry</button>
            </>
          ) : (
            'Loading…'
          )}
        </div>
      ) : (
        <>
          {root === '/artifacts' && (
            <button
              className="tree-refresh"
              aria-label="Refresh results"
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RotateCcw size={11} /> Refresh
            </button>
          )}
          {!files.length && (
            <p className="tree-empty">
              {root === '/artifacts' ? 'No saved text results' : 'No documents'}
            </p>
          )}
        </>
      )}
    </TreeRoot>
  );
}

export function FileTree({
  client,
  snapshot,
  active,
  selectedPath,
  selectFile,
}: {
  client: ControllerClient;
  snapshot: Snapshot;
  active: boolean;
  selectedPath: string;
  selectFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(() => new Set(['/workspace']));
  useEffect(() => {
    setExpanded((current) => new Set([...current, ...directories(selectedPath)]));
  }, [selectedPath]);
  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const files = useMemo(
    () =>
      snapshot.files.map(({ path, revision, updatedAt, content }) => ({
        path,
        revision,
        updatedAt,
        size: content.length,
      })),
    [snapshot.files],
  );
  const shared = {
    expanded,
    toggle,
    selectedPath,
    selectFile,
    bindings: snapshot.workspace.bindings,
  };
  return (
    <aside
      className="file-tree"
      aria-label="Workspace files"
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            'button.tree-file,button.tree-folder',
          ),
        ];
        if (!buttons.length) return;
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : Math.max(
                  0,
                  Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                );
        event.preventDefault();
        buttons[next].focus();
        if (buttons[next].classList.contains('tree-file')) buttons[next].click();
      }}
    >
      <div className="tree-header">
        <span>Files</span>
      </div>
      <Scroller>
        <TreeRoot root="/workspace" files={files} {...shared} />
        <VirtualRoot root="/docs" revision="builtin" client={client} active={active} {...shared} />
        <VirtualRoot
          root="/artifacts"
          revision={snapshot.workspace.artifactsRevision ?? ''}
          client={client}
          active={active}
          {...shared}
        />
      </Scroller>
    </aside>
  );
}
