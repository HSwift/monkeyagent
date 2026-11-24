import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import { AgentError, errorData } from '../protocol/errors';
import type { ToolResult } from '../protocol/types';

export type HostCall = (method: string, args: unknown[], signal?: AbortSignal) => Promise<unknown>;
const METHODS = {
  fs: ['list', 'read', 'write', 'edit', 'remove', 'rename', 'search'],
  browser: [
    'connect',
    'disconnect',
    'evaluate',
    'send',
    'contexts',
    'events',
    'waitForEvent',
    'reload',
    'navigate',
    'screenshot',
    'responseBody',
    'verify',
  ],
  scripts: ['list', 'import', 'apply', 'status', 'setEnabled'],
};

/** QuickJS owns generated JavaScript. No generated code is evaluated by the extension's JS engine. */
export class ReplRuntime {
  private vm: QuickJSContext;
  private serialize: QuickJSHandle;
  warnings: NonNullable<ToolResult['warnings']> = [];
  private deadline = Infinity;
  private pending = new Set<QuickJSDeferredPromise>();
  private hostTasks = new Set<Promise<void>>();
  private active = false;
  private disposed = false;
  constructor(
    module: QuickJSWASMModule,
    private host: HostCall,
  ) {
    this.vm = module.newContext();
    this.vm.runtime.setMemoryLimit(64 * 1024 * 1024);
    this.vm.runtime.setMaxStackSize(1024 * 1024);
    this.vm.runtime.setInterruptHandler(() => Date.now() > this.deadline);
    const call = this.vm.newFunction('__host', (method, json) => {
      const deferred = this.vm.newPromise();
      this.pending.add(deferred);
      const methodName = this.vm.getString(method);
      const args = JSON.parse(this.vm.getString(json)) as unknown[];
      const task = Promise.resolve()
        .then(() => this.host(methodName, args))
        .then(
          (value) => {
            if (this.disposed || !deferred.alive) return;
            const handle = this.vm.newString(JSON.stringify(value ?? null));
            deferred.resolve(handle);
            handle.dispose();
          },
          (error) => {
            if (this.disposed || !deferred.alive) return;
            const data = errorData(error);
            const handle = this.vm.newError({
              name: error?.code ?? 'HostError',
              message: data.message,
            });
            const code = this.vm.newString(data.code);
            this.vm.setProp(handle, 'code', code);
            code.dispose();
            if (data.details) {
              const details = this.vm.unwrapResult(
                this.vm.evalCode(`(${JSON.stringify(data.details)})`),
              );
              this.vm.setProp(handle, 'details', details);
              details.dispose();
            }
            deferred.reject(handle);
            handle.dispose();
          },
        )
        .finally(() => {
          if (deferred.alive) deferred.dispose();
          this.pending.delete(deferred);
          this.hostTasks.delete(task);
        });
      this.hostTasks.add(task);
      return deferred.handle;
    });
    this.vm.setProp(this.vm.global, '__host', call);
    call.dispose();
    const bootstrap =
      `globalThis.state = Object.create(null);\n` +
      `globalThis.sleep = async (ms) => JSON.parse(await __host('runtime.sleep', JSON.stringify([ms])));\n` +
      Object.entries(METHODS)
        .map(
          ([group, methods]) =>
            `globalThis.${group} = Object.freeze({${methods.map((method) => `${JSON.stringify(method)}: async (...args) => JSON.parse(await __host(${JSON.stringify(`${group}.${method}`)}, JSON.stringify(args)))`).join(',')}});`,
        )
        .join('\n');
    const result = this.vm.evalCode(bootstrap);
    this.vm.unwrapResult(result).dispose();
    // Inspect inside QuickJS: vm.dump already omits undefined object fields.
    this.serialize = this.vm.unwrapResult(
      this.vm.evalCode(`(value) => {
        const warnings = [];
        const paths = new WeakMap();
        let root = true;
        const json = JSON.stringify(value, function(key, item) {
          const fullPath = root ? '$' : (paths.get(this) || '$') + '[' + JSON.stringify(key) + ']';
          const path = fullPath.length > 512 ? fullPath.slice(0, 509) + '...' : fullPath;
          root = false;
          if (item && typeof item === 'object') paths.set(item, path);
          if (item === undefined && warnings.length < 10) warnings.push({
            code: path === '$' ? 'undefined_return' : 'undefined_field',
            path,
            message: path === '$'
              ? 'REPL returned undefined. Use an explicit return to inspect results; check that the returned value exists.'
              : 'JSON omits undefined object fields and converts undefined array entries to null. Check API field names; use null for intentionally absent data.'
          });
          return item;
        });
        return {json: json === undefined ? null : json, warnings};
      }`),
    );
  }
  async run(code: string, timeoutMs: number): Promise<unknown> {
    if (this.active) throw new Error('REPL is already running.');
    if (this.disposed) throw new Error('REPL has been disposed.');
    this.active = true;
    this.warnings = [];
    this.deadline = Date.now() + timeoutMs;
    let handle: QuickJSHandle | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const result = this.vm.evalCode(`(async () => {\n${code}\n})()`, 'agent-repl.js');
      handle = this.vm.unwrapResult(result);
      const resolved = this.vm.resolvePromise(handle);
      timer = setInterval(() => {
        if (this.disposed) return;
        const jobs = this.vm.runtime.executePendingJobs();
        if (jobs.error) jobs.error.dispose();
      }, 5);
      this.vm.runtime.executePendingJobs().dispose();
      const value = this.vm.unwrapResult(await resolved);
      try {
        // Even a forgotten await must not let host side effects escape the operation queue.
        while (this.hostTasks.size || this.vm.runtime.hasPendingJob()) {
          await Promise.allSettled([...this.hostTasks]);
          this.vm.runtime.executePendingJobs().dispose();
        }
        const serialized = this.vm.unwrapResult(
          this.vm.callFunction(this.serialize, this.vm.undefined, value),
        );
        try {
          const data = this.vm.dump(serialized) as {
            json: string | null;
            warnings: NonNullable<ToolResult['warnings']>;
          };
          this.warnings = data.warnings;
          return data.json === null ? undefined : JSON.parse(data.json);
        } finally {
          serialized.dispose();
        }
      } finally {
        value.dispose();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = message.match(
        /['"](__hosts__|setTimeout|setInterval|document|window|fetch|chrome|process|require)['"] is not defined/,
      );
      if (missing) {
        const name = missing[1];
        const hint =
          name === '__hosts__'
            ? 'Call fs, browser and scripts directly; __hosts__ is not part of the public API.'
            : name === 'setTimeout' || name === 'setInterval'
              ? 'Use await sleep(ms) in the REPL, or page timers inside browser.evaluate(). For navigation use browser.navigate(url).'
              : 'The REPL has fs/browser/scripts/state/sleep, without DOM, Node or extension globals. Run page JavaScript with browser.evaluate(expression).';
        throw new AgentError('unsupported_global', `${message} ${hint} See /docs/agent-guide.md.`);
      }
      throw error;
    } finally {
      if (timer) clearInterval(timer);
      handle?.dispose();
      this.active = false;
      this.deadline = Infinity;
    }
  }
  dispose() {
    this.disposed = true;
    for (const promise of this.pending) if (promise.alive) promise.dispose();
    this.pending.clear();
    this.serialize.dispose();
    this.vm.dispose();
  }
}
export { newQuickJSWASMModuleFromVariant };
