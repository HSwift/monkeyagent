import guide from '../agent/guides/agent-guide.md?raw';
import browser from '../agent/guides/browser-api.md?raw';
import scripts from '../agent/guides/script-api.md?raw';
import files from '../agent/guides/file-tools.md?raw';
import debugging from '../agent/guides/debugging-workflow.md?raw';
import http from '../agent/guides/http-api.md?raw';
import networks from '../agent/guides/networks-api.md?raw';
import output from '../agent/guides/tool-output.md?raw';

export const API_DOCS: Record<string, string> = {
  '/docs/agent-guide.md': guide,
  '/docs/browser-api.md': browser,
  '/docs/script-api.md': scripts,
  '/docs/file-tools.md': files,
  '/docs/debugging-workflow.md': debugging,
  '/docs/http-api.md': http,
  '/docs/networks-api.md': networks,
  '/docs/tool-output.md': output,
};
