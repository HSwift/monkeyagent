import { cp, mkdir, writeFile } from 'node:fs/promises';
const root = new URL('../fixtures/extension/', import.meta.url);
await mkdir(root, { recursive: true });
await cp(new URL('../dist/', import.meta.url), new URL('agent/', root), { recursive: true });
await writeFile(
  new URL('manifest.json', root),
  JSON.stringify(
    {
      manifest_version: 3,
      name: 'Monkey Agent Fixture',
      version: '0.1.0',
      minimum_chrome_version: '135',
      devtools_page: 'agent/devtools.html',
      permissions: ['debugger', 'storage', 'tabs'],
      host_permissions: ['<all_urls>'],
      background: { service_worker: 'agent/fixture.js', type: 'module' },
      content_security_policy: {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
      },
    },
    null,
    2,
  ),
);
console.log(root.pathname);
