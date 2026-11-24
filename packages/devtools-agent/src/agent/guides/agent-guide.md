# Userscript development quick start

Read this once when a development/debugging task starts. Greetings and capability questions need no tools.

## Tools and REPL

Use Read/Write/Edit/Glob/Grep, with Claude Code-style parameter names. Scripts live under /workspace/, not /scripts/. The old files tool is retained only for historical conversations.

Loaded page source is mounted read-only at /source. Start with Glob({path:"/source",pattern:"**/*.js"}) or fs.list('/source'), then Grep/Read/fs.read using returned paths. For minified source use Grep character windows. Sources are lazy and ephemeral; relist after context_changed. Check Grep search_complete/skipped_count before concluding no match. Full contract: /docs/file-tools.md.

```json
{"file_path":"/workspace/main.user.js","content":"// userscript source"}
```

The example is a Write call. Read uses {file_path, offset?, limit?}, where offset is a 1-based LINE and limit counts lines. Edit uses {file_path, old_string, new_string, replace_all?}: exact whitespace, exactly one match unless replace_all:true. Read existing files first; revisions are tracked internally without an expectedRevision parameter. On conflict, reread and reconcile. Write/Edit return metadata without echoing the source. Glob uses {pattern,path?}; Grep uses regex {pattern,path?,glob?,output_mode?,char_context?}. For minified text, use output_mode:"content",char_context:200 for windows around each match and follow next_offset when paginated. See /docs/file-tools.md for the full contract and limits.

REPL code is JavaScript inside QuickJS, with await and explicit return:

```js
const page = await browser.evaluate('({title:document.title,url:location.href})');
const installed = await scripts.list();
return {page, installed};
```

The repl tool takes {code, timeout?, description?, output_file?}; timeout is milliseconds, default 15000, maximum 60000. description briefly states the purpose. It runs JavaScript, not a shell, and has no background mode. Call fs/http/networks/browser/scripts directly. There is NO __hosts__ wrapper. Locals do not survive the call; put reusable values in state. No DOM, chrome, Node, global fetch, setTimeout or setInterval in the REPL. Use `await sleep(100)` for short, cancellable delays. DOM operations and page timers belong inside browser.evaluate().

Use `await http.request(absoluteHttpUrl, {method?,headers?,body?,credentials?,redirect?,timeoutMs?})` for extension-origin HTTP using granted host permissions. It returns plain {status,statusText,ok,url,redirected,headers,body,base64Encoded,bodyBytes}; parse text JSON with JSON.parse(response.body). It is not Node http or a native Response. Credentials default to omit; include is explicit and still follows browser cookie policy. Response limits are 2 MiB decoded bytes / 3 MiB serialized JSON, request body 2 MiB UTF-8, at most four concurrent requests. HTTP errors resolve with ok:false; network/timeout/limits reject with code/details. Stop and the enclosing REPL deadline cancel outstanding HTTP without retry. Saving remains explicit. Full contract: /docs/http-api.md. Page-origin fetch stays inside browser.evaluate; browser.fetch does not exist.

Use `networks.list({urlFilter?,methods?,types?,statusCodes?,offset?,limit?})` for captured page requests, then `networks.get(id)`, `requestBody(id)` or `responseBody(id,{offset?,limit?})`. It automatically reuses the real F12 Network HAR log and native body reader, without attaching a debugger or changing recording/settings. F12 Clear and Preserve log own retention. IDs are opaque metadata-version IDs: relist after context_changed, and never use them as CDP requestIds. Full API, pagination, body limits and native getHAR log shape: /docs/networks-api.md. Read errors never fetch/replay a missing response. Use http.request only for an explicitly new request.

Use output_file:"/workspace/scratch/result.json" to save ONLY the final return value as JSON and receive {path,revision,size,updatedAt} instead of echoing it into the conversation. Internal function values and state remain unchanged. The path must be new; saved strings are JSON-quoted, and the existing workspace content limit applies. Read/Grep the saved file or use fs.read for character ranges. Without output_file, the automatic artifact budget below applies. If error.details.replCompleted is true, the code already ran and only output saving failed: inspect state/files before retrying, and do not repeat mutations to obtain another output. See /docs/browser-api.md for format and failure details.

Without output_file, REPL final JSON above 8 KiB UTF-8 is automatically saved in full under /artifacts/. The tool returns a 2 KiB head/tail preview, value.artifact.path/size, a recovery notice and truncated:true. Function values and state stay complete. Use Read/Grep on the returned path, or fs.read(path,{offset,limit:2000}); do not rerun code to recover omitted output. fs.list('/artifacts') lists text results, and artifacts are read-only. If output_save_failed appears, code completed but the full output was not saved. Full contract: /docs/tool-output.md.

Use browser.navigate(absoluteUrl, options) to navigate and await readiness together. Changing location then calling waitForEvent can miss an event. Prefer a concrete readiness condition over arbitrary sleeps; the whole REPL timeout must cover navigation and subsequent checks. API details: /docs/browser-api.md and /docs/script-api.md. These browser helpers are our bridge, with their own contracts; browser.send takes native CDP names/parameters and preserves native result fields. Read /docs/debugging-workflow.md when diagnosing failures.

Unknown tool fields and helper options are rejected. REPL results can include warnings about undefined values lost to JSON; inspect them instead of treating missing fields as success. scripts.apply/status provide actual installed version/revision metadata. Read those values rather than returning the expected version as a constant. scripts.status.verification is explicitly null or the latest {passed,detail,at}, not a summary of every check.

REPL compilation errors and missing page SyntaxError positions share `(line N, column M)`: 1-based user-code lines and UTF-16 columns, with unknown columns omitted. REPL positions account for its async wrapper; page positions retain their page origin. Existing locations/stacks are preserved once. Runtime JSON.parse errors are not treated as compilation errors, and code is never rerun to obtain a position. Details: /docs/browser-api.md.

## A small, complete development loop

1. Inspect the target and nearby content in one bounded page query. Capture relevant before/after invariants: target count, parent presence, important sibling content. Avoid dumping the whole DOM.
2. Implement the smallest requested change. Removing a target does not authorize deleting its parent or adjacent containers. At document-start, an empty parent may still be receiving parser-inserted children: never remove it just because it is temporarily empty. For dynamic pages, use a scoped observer without repeatedly traversing unrelated content.
3. Include valid metadata: name, namespace, version, appropriate @match, @grant and @run-at. Save under /workspace/, install with scripts.apply(path), then browser.reload(). Do not substitute eval for Monkey injection.
4. Verify the requested effect AND preserved neighboring content. For removal, check target absence, parent/sibling invariants and dynamic reinsertion when relevant. Clean up probes. Check every returned `.passed`, not just whether the REPL succeeded.
5. When a check fails, distinguish a broken assertion from a broken script using the original task and captured invariants. Do not weaken a check or redefine disappearing sibling content as success. Repair and rerun relevant checks. Use a disable/reload control only when needed to isolate a regression; restore the intended enabled state.
6. Stop when the task's checks pass and relevant errors are checked. Avoid unrelated navigation, broad compatibility claims, repeated screenshots or cosmetic additions. Screenshot references are not visual evidence with image input disabled. Briefly report installed changes, actual checks and limits.

Use browser.events() as the returned array, never as an assumed {events:…} wrapper. See the log bookmark example in /docs/browser-api.md. Do not infer authentication or application state from the absence of a single optional DOM class; report observed evidence and uncertainty.

## Recovery

Long conversations may be replaced in model input by an earlier-conversation checkpoint plus recent complete exchanges. Treat the checkpoint as historical context and preserve the user's constraints and pending work. Compaction does not rerun tools or reset REPL state. The full transcript stays in the UI; saved /workspace/ and /artifacts/ paths remain usable. Refreshing the panel still recreates the REPL worker, so inspect current state rather than assuming a checkpoint restores variables.

- invalid_path: use /workspace/<name>.user.js, preserving source content.
- invalid_input: check the named tool's required parameters and resend a corrected call; do not repeat a large source file in the error explanation.
- unsupported_global: use the direct public API; sleep() replaces REPL timers.
- context_changed: reacquire contexts/handles after navigation.
- conflict/external_conflict: reread and reconcile; preserve manual or external changes.
- timeout/interrupted/unknown: dispatched actions may have taken effect. Inspect file/script/page state before repeating mutations.
