/// <reference lib="webworker" />
import variant from '@jitl/quickjs-wasmfile-release-sync';
import wasmURL from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
import { newVariant } from 'quickjs-emscripten-core';
import { ReplRuntime, newQuickJSWASMModuleFromVariant } from './runtime';
import { errorData, AgentError } from '../protocol/errors';

const hostCalls = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const runtime = newQuickJSWASMModuleFromVariant(
  newVariant(variant, { wasmLocation: wasmURL }),
).then(
  (module) =>
    new ReplRuntime(
      module,
      (method, args) =>
        new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          hostCalls.set(id, { resolve, reject });
          postMessage({ type: 'host', id, method, args });
        }),
    ),
);

self.onmessage = async (event) => {
  const data = event.data;
  if (data.type === 'host-result') {
    const pending = hostCalls.get(data.id);
    if (!pending) return;
    hostCalls.delete(data.id);
    if (data.error)
      pending.reject(new AgentError(data.error.code, data.error.message, data.error.details));
    else pending.resolve(data.value);
  } else if (data.type === 'run') {
    try {
      const repl = await runtime;
      const value = await repl.run(data.code, data.timeoutMs);
      postMessage({
        type: 'result',
        id: data.id,
        value,
        warnings: repl.warnings,
      });
    } catch (error) {
      postMessage({ type: 'result', id: data.id, error: errorData(error) });
    }
  }
};
