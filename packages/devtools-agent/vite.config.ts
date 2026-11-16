import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { thirdPartyNotices } from './scripts/licenses.ts';

export default defineConfig({
  base: './',
  plugins: [react(), thirdPartyNotices()],
  css: { postcss: { plugins: [] } },
  build: {
    target: 'chrome135',
    assetsInlineLimit: 0,
    sourcemap: true,
    rollupOptions: {
      input: {
        devtools: resolve(import.meta.dirname, 'devtools.html'),
        panel: resolve(import.meta.dirname, 'panel.html'),
        fixture: resolve(import.meta.dirname, 'src/fixtures/background.ts'),
      },
      output: { entryFileNames: '[name].js' },
    },
  },
  worker: { format: 'es' },
  test: { include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], environment: 'jsdom' },
});
