import type { FileRecord } from '../protocol/types';

export interface SourceFile {
  path: string;
  revision: string;
  updatedAt: number;
  /** Decoded UTF-16 length; -1 until read. */
  size: number;
  sourceUrl?: string;
  kind: string;
  provider: 'devtools' | 'page' | 'debugger';
  frameId?: string;
  sessionId?: string;
  scriptId?: string;
  sourceMapURL?: string;
  availability?: 'unread' | 'cached';
}

export type SourceRecord = FileRecord & Omit<SourceFile, keyof FileRecord>;

export interface SourceProvider {
  list(): Promise<SourceFile[]>;
  read(path: string): Promise<SourceRecord>;
}

export const SOURCE_FILE_BYTES = 8 * 1024 * 1024;
export const SOURCE_CACHE_BYTES = 32 * 1024 * 1024;
export const SOURCE_SCAN_BYTES = 8 * 1024 * 1024;
