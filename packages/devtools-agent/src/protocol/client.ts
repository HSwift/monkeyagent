import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { AgentError } from './errors';
import type { PortEvent, PortResponse, Snapshot } from './types';

export class ControllerClient {
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private subscribers = new Set<(snapshot: Snapshot) => void>();
  private streams = new Map<string, ReadableStreamDefaultController<UIMessageChunk>>();
  private port?: MessagePort;
  private ready: Promise<void>;
  private markReady!: () => void;
  constructor() {
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }
  connect(port: MessagePort) {
    this.port?.close();
    this.port = port;
    port.onmessage = ({ data }: MessageEvent<PortEvent | PortResponse>) => {
      if (data.type === 'response') {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        if (data.error) pending.reject(new AgentError(data.error.code, data.error.message));
        else pending.resolve(data.result);
      } else if (data.type === 'event') {
        if (data.event === 'snapshot')
          for (const listener of this.subscribers) listener(data.data as Snapshot);
        if (data.streamId) {
          const stream = this.streams.get(data.streamId);
          if (!stream) return;
          if (data.event === 'chunk') stream.enqueue(data.data as UIMessageChunk);
          else if (data.event === 'stream-end') {
            stream.close();
            this.streams.delete(data.streamId);
          } else if (data.event === 'stream-error') {
            stream.error(new Error(String(data.data)));
            this.streams.delete(data.streamId);
          }
        }
      }
    };
    port.start();
    this.markReady();
  }
  async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    await this.ready;
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port!.postMessage({ type: 'request', id, method, args });
    });
  }
  subscribe(listener: (snapshot: Snapshot) => void) {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
  async stream(
    messages?: UIMessage[],
    signal?: AbortSignal,
    conversationId?: string,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const streamId = crypto.randomUUID();
    let streamController!: ReadableStreamDefaultController<UIMessageChunk>;
    const cancel = () => {
      void this.call('stop');
    };
    const stream = new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        streamController = controller;
        this.streams.set(streamId, controller);
      },
      cancel: () => {
        this.streams.delete(streamId);
        signal?.removeEventListener('abort', cancel);
        cancel();
      },
    });
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await this.call(
        messages ? 'chat.start' : 'chat.resume',
        streamId,
        messages,
        conversationId,
      );
      if (!result) {
        streamController.close();
        this.streams.delete(streamId);
        return null;
      }
    } catch (error) {
      streamController.error(error);
      this.streams.delete(streamId);
    }
    return stream;
  }
}
export class ControllerChatTransport implements ChatTransport<UIMessage> {
  readonly resumeStreamIsReplay = true;
  constructor(
    private client: ControllerClient,
    private conversationId: string,
  ) {}
  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]) {
    return (await this.client.stream(messages, abortSignal, this.conversationId))!;
  }
  reconnectToStream({ abortSignal }: Parameters<ChatTransport<UIMessage>['reconnectToStream']>[0]) {
    return this.client.stream(undefined, abortSignal, this.conversationId);
  }
}
