# Userscript development quick start

Read this once when a development/debugging task starts. Greetings and capability questions need no tools.

## Tools and REPL

Use Read/Write/Edit/Glob/Grep, with Claude Code-style parameter names. Scripts live under /workspace/, not /scripts/. The old files tool is retained only for historical conversations.

```json
{"file_path":"/workspace/main.user.js","content":"// userscript source"}
```

The example is a Write call. Read uses {file_path, offset?, limit?}, where offset is a 1-based LINE and limit counts lines. Edit uses {file_path, old_string, new_string, replace_all?}: exact whitespace, exactly one match unless replace_all:true. Read existing files first; revisions are tracked internally without an expectedRevision parameter. On conflict, reread and reconcile. Write/Edit return metadata without echoing the source. Glob uses {pattern,path?}; Grep uses regex {pattern,path?,glob?,output_mode?}. See /docs/file-tools.md for the full contract and limits.

REPL code is JavaScript inside QuickJS, with await and explicit return:

```js
const page = await browser.evaluate('({title:document.title,url:location.href})');
const installed = await scripts.list();
return {page, installed};
```

The repl tool takes {code, timeout?, description?}; timeout is milliseconds, default 15000, maximum 60000. description briefly states the purpose. It runs JavaScript, not a shell, and has no background mode. Call fs/browser/scripts directly. There is NO __hosts__ wrapper. Locals do not survive the call; put reusable values in state. No DOM, chrome, Node, fetch, setTimeout or setInterval in the REPL. Use `await sleep(100)` for short, cancellable delays. DOM operations and page timers belong inside browser.evaluate().

Use browser.navigate(absoluteUrl, options) to navigate and await readiness together. Changing location then calling waitForEvent can miss an event. Prefer a concrete readiness condition over arbitrary sleeps; the whole REPL timeout must cover navigation and subsequent checks. API details: /docs/browser-api.md and /docs/script-api.md. These browser helpers are our bridge, with their own contracts; browser.send takes native CDP names/parameters and preserves native result fields. Read /docs/debugging-workflow.md when diagnosing failures.

Unknown tool fields and helper options are rejected. REPL results can include warnings about undefined values lost to JSON; inspect them instead of treating missing fields as success. scripts.apply/status provide actual installed version/revision metadata. Read those values rather than returning the expected version as a constant. scripts.status.verification is explicitly null or the latest {passed,detail,at}, not a summary of every check.

## A small, complete development loop

1. Inspect the target and nearby content in one bounded page query. Capture relevant before/after invariants: target count, parent presence, important sibling content. Avoid dumping the whole DOM.
2. Implement the smallest requested change. Removing a target does not authorize deleting its parent or adjacent containers. At document-start, an empty parent may still be receiving parser-inserted children: never remove it just because it is temporarily empty. For dynamic pages, use a scoped observer without repeatedly traversing unrelated content.
3. Include valid metadata: name, namespace, version, appropriate @match, @grant and @run-at. Save under /workspace/, install with scripts.apply(path), then browser.reload(). Do not substitute eval for Monkey injection.
4. Verify the requested effect AND preserved neighboring content. For removal, check target absence, parent/sibling invariants and dynamic reinsertion when relevant. Clean up probes. Check every returned `.passed`, not just whether the REPL succeeded.
5. When a check fails, distinguish a broken assertion from a broken script using the original task and captured invariants. Do not weaken a check or redefine disappearing sibling content as success. Repair and rerun relevant checks. Use a disable/reload control only when needed to isolate a regression; restore the intended enabled state.
6. Stop when the task's checks pass and relevant errors are checked. Avoid unrelated navigation, broad compatibility claims, repeated screenshots or cosmetic additions. Screenshot references are not visual evidence with image input disabled. Briefly report installed changes, actual checks and limits.

Use browser.events() as the returned array, never as an assumed {events:…} wrapper. See the log bookmark example in /docs/browser-api.md. Do not infer authentication or application state from the absence of a single optional DOM class; report observed evidence and uncertainty.

## Recovery

- invalid_path: use /workspace/<name>.user.js, preserving source content.
- invalid_input: check the named tool's required parameters and resend a corrected call; do not repeat a large source file in the error explanation.
- unsupported_global: use the direct public API; sleep() replaces REPL timers.
- context_changed: reacquire contexts/handles after navigation.
- conflict/external_conflict: reread and reconcile; preserve manual or external changes.
- timeout/interrupted/unknown: dispatched actions may have taken effect. Inspect file/script/page state before repeating mutations.
