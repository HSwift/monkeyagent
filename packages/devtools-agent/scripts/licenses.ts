import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

export function thirdPartyNotices(): Plugin {
  return {
    name: 'monkeyagent-third-party-notices',
    async generateBundle() {
      const directories = new Set<string>();
      for (const id of this.getModuleIds()) {
        if (!id.includes('/node_modules/')) continue;
        let directory = dirname(id.split('?')[0]);
        while (directory.includes('/node_modules/')) {
          try {
            await readFile(resolve(directory, 'package.json'));
            directories.add(directory);
            break;
          } catch {}
          directory = dirname(directory);
        }
      }
      // Workers use the same packaged QuickJS implementation but have a separate module graph.
      for (const name of ['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync'])
        directories.add(resolve(import.meta.dirname, '../node_modules', name));
      const notices = new Map<string, string>();
      for (const directory of directories) {
        try {
          const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
          const files = (await readdir(directory)).filter((name) =>
            /^(licen[cs]e|notice|copyright)([.\-_]|$)/i.test(name),
          );
          const text = await Promise.all(
            files.map((name) => readFile(resolve(directory, name), 'utf8')),
          );
          notices.set(
            `${pkg.name}@${pkg.version}`,
            `${pkg.name}@${pkg.version}\nLicense: ${pkg.license ?? 'See source'}\n${text.join('\n\n')}`,
          );
        } catch {}
      }
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_LICENSES.txt',
        source: [...notices]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text)
          .join('\n\n' + '='.repeat(78) + '\n\n'),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY.md',
        source: await readFile(new URL('../THIRD_PARTY.md', import.meta.url), 'utf8'),
      });
    },
  };
}
