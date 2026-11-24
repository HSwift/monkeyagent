import { useEffect, useState } from 'react';
import { Button } from '../components/ui';
import { CodeEditor } from '../components/code-editor';
import type { ControllerClient } from '../protocol/client';
import type { ArtifactRecord, FileRecord } from '../protocol/types';

const PAGE_SIZE = 32000;
type Page = FileRecord & { offset: number; totalLength: number };

export function ReadonlyFileViewer({ path, client }: { path: string; client: ControllerClient }) {
  const artifact = path.startsWith('/artifacts/');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setPage(undefined);
    setError('');
    client
      .call<FileRecord & Partial<Page>>(
        'files.read',
        path,
        artifact ? { offset, limit: PAGE_SIZE } : undefined,
      )
      .then(
        (value) => {
          if (active)
            setPage({
              ...value,
              offset: value.offset ?? 0,
              totalLength: value.totalLength ?? value.content.length,
            });
        },
        (error) => {
          if (active) setError(error instanceof Error ? error.message : String(error));
        },
      );
    return () => {
      active = false;
    };
  }, [client, path, offset]);
  async function download() {
    if (!page) return;
    setBusy(true);
    try {
      const blob = artifact
        ? (await client.call<ArtifactRecord>('artifact.get', page.revision)).blob
        : new Blob([page.content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = path.split('/').pop() ?? 'result.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="file-toolbar">
        <span className="file-path">{path}</span>
        <span className="muted small readonly-label">
          {artifact ? 'Read-only result' : 'Read-only documentation'}
        </span>
        <Button onClick={() => void download()} disabled={!page || busy}>
          Download
        </Button>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {page ? (
        <>
          <div className="editor-container">
            <CodeEditor value={page.content} readOnly />
          </div>
          <div className="file-toolbar">
            <span className="muted small">
              Characters {page.totalLength ? offset + 1 : 0}–{offset + page.content.length} of{' '}
              {page.totalLength}
            </span>
            <Button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
            >
              Previous
            </Button>
            <Button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + page.content.length >= page.totalLength}
            >
              Next
            </Button>
          </div>
        </>
      ) : (
        !error && <p className="muted">Loading result…</p>
      )}
    </>
  );
}
