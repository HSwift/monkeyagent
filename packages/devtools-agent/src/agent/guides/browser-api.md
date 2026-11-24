# Browser REPL API

Top-level REPL supports await, explicit return, direct fs/http/networks/browser/scripts and cross-call state. `await sleep(ms)` supports 0–60000 ms and is cancelled by stop. setTimeout/setInterval are only available in PAGE code. Extension-origin HTTP uses `http.request(url, options)`; see /docs/http-api.md. It is independent of the inspected page's origin and debugger attachment. Captured requests use the separate automatic F12 `networks` API; see /docs/networks-api.md. Page-origin fetch stays inside browser.evaluate; browser.fetch is not implemented.

All browser operations target the bound inspected tab and its attached iframe/Worker sessions, regardless of the active tab.

## Bridge helpers and native CDP

`browser.evaluate/navigate/reload/events/waitForEvent/screenshot/verify` are project-defined helpers, not CDP commands. Their arguments, defaults and results are defined here. For example, navigate waits for readiness and returns an event; evaluate unwraps the page value and throws page exceptions. `sleep` is a REPL helper.

`browser.send(method, params, sessionId?)` is the native CDP escape hatch. Use the official command name, parameter names and result fields as documented by CDP. It does not translate arguments or unwrap/rename result fields. For example, Runtime.evaluate returns `{result, exceptionDetails?}`, while Page.navigate returns `{frameId, loaderId?, errorText?, ...}` and does not itself wait for document readiness. A successful protocol call can still contain exceptionDetails or errorText; inspect them. Use send when helper defaults do not fit, such as evaluation with remote objects or navigation with referrer/frameId.

This transport still enforces the inspected-tab scope, owned child sessions, stale-handle checks and a 256 KiB result limit. Unsupported commands/domains remain subject to Chrome's debugger restrictions. Errors keep the browser's message inside the harness error envelope; they are not invented CDP results. See /docs/debugging-workflow.md for recovery and verification recipes.

## Arguments and results

Named file tools and repl reject unknown input fields. REPL host calls validate argument types, counts and helper options before dispatching that call. For example, navigation helpers accept timeoutMs, while the repl tool accepts timeout; neither silently ignores a misspelled option. browser.send only validates its transport arguments (method string, params object, optional sessionId); native command parameters pass through unchanged and Chrome validates them. An error does not roll back earlier host calls in the same REPL invocation.

Return JSON data explicitly. The outer tool result uses {success, value?, error?, durationMs, warnings?}. success means execution completed, not that a returned boolean/check passed. durationMs measures the entire tool invocation, not frame timing or the time a particular DOM change took. warnings do not mark an otherwise successful operation as failed.

REPL serialization reports up to 10 warnings for undefined return values or nested fields. Undefined object fields are omitted by JSON; undefined array entries become null. A misspelled property can therefore disappear from the result. Check warnings and the API contract, and use null for intentionally absent data. These diagnostics preserve normal JavaScript property access and do not rewrite native CDP result fields or infer whether an assertion is correct.

## Saving the final REPL result

The outer repl tool accepts {code, timeout?, description?, output_file?}. output_file is a NEW absolute /workspace/ file path. The code runs once and its final return value is saved as compact JSON; the tool returns only {path,revision,size,updatedAt}. size counts UTF-16 characters. Function return values, calculations and state inside the interpreter are unchanged. Without output_file, final JSON up to 8 KiB UTF-8 is returned inline; larger results are saved to /artifacts with a 2 KiB head/tail preview, artifact reference and truncated:true. Recover through Read/Grep or small fs.read ranges; see /docs/tool-output.md. This parameter does not bypass browser/Worker/input limits.

```json
{"code":"state.values = [1,2,3]; return state.values;","output_file":"/workspace/scratch/values.json"}
```

This is a repl TOOL call, not code to execute inside it. The file contains [1,2,3]. Strings are JSON-quoted; an undefined return is stored as JSON null with the existing undefined_return warning. Use explicit fs.write when raw text or in-code handling of write errors is needed.

Paths and known conflicts are checked before running. Existing targets are never overwritten; the final write checks atomically for a concurrent creator. The workspace limit is 2*1024*1024 UTF-16 characters of serialized JSON. An oversized output fails with size_limit; it is not redirected to another path or artifact. Execution failure creates no output file.

On a preflight error, error.details includes {phase:"preflight",replCompleted:false,output_file}. On a save failure AFTER the code returned, it includes {phase:"output",replCompleted:true,output_file}: code and side effects already ran, and state remains available unless a normal stop/reset occurred. Saving failure is outside the code's try/catch. Do not rerun mutations just to retry output saving; inspect current state and choose a new path when necessary. Read/Grep the saved file, or use fs.read ranges for large text.

## Browser method reference

| Call | Result / behavior |
| --- | --- |
| browser.connect(), browser.disconnect() | Native debugger attachment/detachment. First operation connects automatically; after detach, reconnect explicitly. |
| browser.evaluate(expression, {contextId?, sessionId?}) | Evaluates a JavaScript STRING in the page, awaits promises and returns JSON. Page code has DOM/timers, but no REPL fs/scripts/state. Exceptions fail the tool. |
| browser.navigate(absoluteUrl, {waitUntil?, timeoutMs?}) | Navigates to HTTP(S), registering readiness listeners BEFORE navigation. Handles same-document navigation too. |
| browser.reload({waitUntil?, timeoutMs?}) | Reloads with actual Monkey injection. Default waitUntil is domcontentloaded; load is also supported. |
| browser.send(method, params = {}, sessionId?) | Native CDP command, returning the protocol object unchanged. Target discovery/attachment is managed internally. |
| browser.contexts() | ARRAY of {id, name, origin, auxData?, sessionId?}. |
| browser.events({after?, methods?, limit?, tail?}) | ARRAY of {seq, method, params, at, sessionId?}, not {events:…}. Page with the last seq as after. Default 50, maximum 200. tail:true selects the latest entries, useful for bookmarking before an action. |
| browser.waitForEvent(method, {timeoutMs?, sessionId?}) | Waits for a NEW event, not one already buffered. Register before an action; prefer navigate/reload for navigation. |
| browser.screenshot({format?: 'png' \| 'jpeg'}) | Saves a Blob; returns {id, path, mimeType, size}. Return the reference to attach it to an image-capable model. A text-only model cannot inspect pixels. |
| browser.responseBody(requestId, sessionId?) | {body, base64Encoded}, at most 256 KiB. Read only relevant responses. |
| browser.verify(path, expression) | Boolean assertion for the installed file revision; returns {passed, detail, at}. False is a failed CHECK even when REPL succeeds. |

Navigation timeoutMs defaults to 15 s, at most 60 s. The repl tool's timeout defaults to 15 s TOTAL: set it high enough for navigation plus checks. Use Input.dispatchMouseEvent / Input.dispatchKeyEvent for native interaction and Debugger.evaluateOnCallFrame when paused. Navigation invalidates context IDs, remote objects and callFrame IDs; reacquire after context_changed.

browser.evaluate throws page_exception for page errors. Native Error messages and their existing text stacks are preserved without adding duplicate description/stack/details fields. A SyntaxError without an existing location gets its reliable CDP position appended once as `(line N, column M)` (1-based; column omitted when unavailable). Non-Error thrown values are identified as `Thrown value: ...`; objects use the browser-provided preview only, at most five properties and 2000 UTF-16 characters, with `…` / `[truncated]` marking omissions. These previews are diagnostic text, not complete JSON or a new evaluation of the thrown object. No getters are invoked or code retried to expand them. Use browser.send('Runtime.evaluate', ...) when the original protocol exceptionDetails are required.

REPL compilation errors use the same `(line N, column M)` suffix. Both formats use 1-based user-code lines and UTF-16 columns; tabs count as one column. QuickJS coordinates are mapped past the async wrapper and converted from its code-point/LF coordinates, including emoji and CR/Unicode line separators. A missing column is omitted. A position in generated wrapper code or an ambiguous/unavailable coordinate is left out. Runtime errors (including JSON.parse SyntaxError), host errors and page_exception keep their existing messages/codes; a page position is never shifted by the REPL wrapper. Existing located messages/stacks remain intact without another suffix or duplicate stack/details fields.

```js
await browser.navigate('https://example.com/', {waitUntil:'domcontentloaded'});
return await browser.evaluate('({ready:document.readyState,count:document.querySelectorAll(".target").length})');
```

File APIs: fs.list(prefix?), fs.read(path, {offset?, limit?}?), fs.write(path, content, expectedRevision?), fs.edit(path, search, replacement, expectedRevision), fs.remove(path, expectedRevision), fs.search(query, prefix?), fs.rename(path, to, expectedRevision). Mutations return revision metadata without source. Ranges are at most 64000 characters and include totalLength/offset/truncated. /docs, /source and /artifacts are read-only. Scripts belong under /workspace/. Discover loaded page source with fs.list('/source'), then read returned paths. Use the Grep tool for source searches and its coverage report; fs.search searches saved workspace files and rejects /source. See /docs/file-tools.md for source limits, cache and lifecycle. In a REPL catch, host errors expose error.code and optional error.details; error.name retains the code for compatibility.

## Check logs without discarding evidence

Connect before testing so native error collection is active. Bookmark before a reload/action; read events since that point and paginate if needed. An empty list means no matching events in the retained range, not proof that the whole site has no errors. No need to inject late page error handlers that only collect future errors.

```js
await browser.connect();
state.logStart = (await browser.events({tail:true,limit:1})).at(-1)?.seq ?? 0;
await browser.reload();
const events = await browser.events({after:state.logStart,
  methods:['Runtime.exceptionThrown','Runtime.consoleAPICalled','Log.entryAdded'],limit:200});
return events.filter(e => e.method === 'Runtime.exceptionThrown' ||
  e.params.type === 'error' || e.params.entry?.level === 'error');
```

Use the returned ARRAY directly. Never use `(events.events || [])`: it discards real events. Runtime.exceptionThrown is an exception even if its message does not contain the word "error". Do not swallow navigation/wait failures with catch(()=>null) and then claim the page was verified. Report failed waits and inspect current readiness before continuing.

Native references: [chrome.debugger transport and restrictions](https://developer.chrome.com/docs/extensions/reference/api/debugger), [Runtime.evaluate](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate), [Page.navigate](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-navigate). The browser's implemented protocol version is authoritative; tip-of-tree documentation can include newer commands.
