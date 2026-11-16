import { useEffect, useState, type ReactNode } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import Markdown from 'react-markdown';
import {
  ArrowDown,
  ChevronRight,
  Check,
  CircleAlert,
  LoaderCircle,
  FileCode2,
  ImageIcon,
} from 'lucide-react';
import { Collapsible, Button } from './ui';
import type { UIMessage } from 'ai';
import type { ArtifactRecord, ArtifactRef, ToolResult } from '../protocol/types';
import type { ControllerClient } from '../protocol/client';

export function Conversation({ children }: { children: ReactNode }) {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    initial: 'instant',
    resize: 'smooth',
  });
  return (
    <div className="conversation">
      <div ref={scrollRef} className="conversation-scroll">
        <div ref={contentRef} className="conversation-content">
          {children}
        </div>
      </div>
      {!isAtBottom && (
        <Button
          className="scroll-bottom"
          onClick={() => scrollToBottom()}
          aria-label="跳到最新消息"
        >
          <ArrowDown size={14} />
          最新消息
        </Button>
      )}
    </div>
  );
}
export function ArtifactImage({
  reference,
  client,
}: {
  reference: ArtifactRef;
  client: ControllerClient;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let objectURL: string | undefined;
    client
      .call<ArtifactRecord>('artifact.get', reference.id)
      .then((data) => {
        if (alive) {
          objectURL = URL.createObjectURL(data.blob);
          setUrl(objectURL);
        }
      })
      .catch((error) => setError(error.message));
    return () => {
      alive = false;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [reference.id]);
  if (error) return <span className="error-text">{error}</span>;
  if (!url)
    return (
      <span className="muted">
        <ImageIcon size={14} />
        加载截图…
      </span>
    );
  return (
    <a href={url} target="_blank" rel="noreferrer" className="artifact-image">
      <img src={url} alt="被检查页面的截图" />
      <span>
        {reference.mimeType} · {(reference.size / 1024).toFixed(0)} KB
      </span>
    </a>
  );
}
function ToolCard({
  part,
  client,
  openFile,
}: {
  part: Record<string, any>;
  client: ControllerClient;
  openFile: (path: string) => void;
}) {
  const complete = part.state === 'output-available' || part.state === 'output-error';
  const result = part.output as ToolResult | undefined;
  const failed = part.state === 'output-error' || result?.success === false;
  const name = part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5);
  const path = (part.input?.file_path ?? part.input?.path) as string | undefined;
  return (
    <Collapsible.Root className={`tool-card ${failed ? 'tool-failed' : ''}`}>
      <Collapsible.Trigger className="tool-trigger">
        <ChevronRight size={13} className="chevron" />
        {complete ? (
          failed ? (
            <CircleAlert size={14} />
          ) : (
            <Check size={14} />
          )
        ) : (
          <LoaderCircle size={14} className="spin" />
        )}
        <span className="tool-name">
          {name === 'files'
            ? `${part.input?.op ?? '文件操作'} ${path?.split('/').pop() ?? ''}`
            : name === 'repl'
              ? (part.input?.description ?? 'JavaScript REPL')
              : `${name} ${path?.split('/').pop() ?? part.input?.pattern ?? ''}`}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content className="tool-details">
        {path && (
          <button className="file-link" onClick={() => openFile(path)}>
            <FileCode2 size={12} />
            {path}
          </button>
        )}
        <p className="eyebrow">输入</p>
        <pre>{part.input?.code ?? JSON.stringify(part.input ?? {}, null, 2)}</pre>
        <p className="eyebrow">结果</p>
        <pre>{part.errorText ?? JSON.stringify(result ?? null, null, 2)}</pre>
        {result && <p className="eyebrow">用时 {Math.round(result.durationMs)} ms</p>}
        {result?.artifacts
          ?.filter((ref) => ref.mimeType.startsWith('image/'))
          .map((ref) => (
            <ArtifactImage key={ref.id} reference={ref} client={client} />
          ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
export function ChatMessage({
  message,
  client,
  openFile,
}: {
  message: UIMessage;
  client: ControllerClient;
  openFile: (path: string) => void;
}) {
  return (
    <article className={`message message-${message.role}`}>
      <div className="message-author sr-only">{message.role === 'user' ? '你' : 'Agent'}</div>
      <div className="message-body">
        {message.parts.map((part, index) =>
          part.type === 'text' ? (
            <div className="markdown" key={index}>
              {message.role === 'user' ? (
                <p className="user-text">{part.text}</p>
              ) : (
                <Markdown>{part.text}</Markdown>
              )}
            </div>
          ) : part.type.startsWith('tool-') || part.type === 'dynamic-tool' ? (
            <ToolCard key={index} part={part} client={client} openFile={openFile} />
          ) : null,
        )}
      </div>
    </article>
  );
}
