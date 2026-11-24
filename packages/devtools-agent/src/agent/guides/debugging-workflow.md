# Debugging contracts and evidence

Read this when diagnosing a script, a failed check or a browser-tool error. API signatures are in /docs/browser-api.md and /docs/script-api.md.

## Execution and return values

REPL code runs in QuickJS. Use fs/http/networks/browser/scripts/state directly, with await and an explicit return. DOM and page timers belong inside the string passed to browser.evaluate. Page code cannot access REPL variables; transfer JSON values explicitly. Keep reusable data in state across calls. Use http.request for extension-origin HTTP; page fetch follows page CORS and uses a different credential context. See /docs/http-api.md for limits and cancellation.

Use networks.list/get/requestBody/responseBody/getHAR to inspect the existing F12 Network log. No start/connect is required, and queries do not change native recording. Fresh snapshots follow F12 Clear and Preserve log. Missing historical bodies fail without issuing a new request. Relist after context_changed; networks IDs are not CDP requestIds. See /docs/networks-api.md for scope and limits. Existing browser.events remains a separate bounded CDP event buffer with its original capture lifetime.

Browser helpers have their own contracts. browser.send uses native CDP names, arguments and result envelopes. Do not infer one interface's result shape from another or pass helper options to native commands.

Host arguments and helper options are validated before dispatch. Invalid input is reported rather than silently fixed. Earlier host calls in the same REPL invocation are not rolled back. Inspect warnings for undefined values lost to JSON serialization: a missing field is not evidence of success. Use null for intentional absence.

## Facts, assertions and coverage

Automatic context compaction only changes model input: a no-tools summary call preserves objectives, constraints, verified work, remaining actions and useful paths, followed by recent complete exchanges. It never reruns tools or restarts the REPL. The summary and covered transcript boundary persist per session; original messages remain available in the UI and debug pack. A checkpoint is historical evidence, not proof that state survived a panel reload or an operation succeeded. Inspect current files/page/state when an outcome is uncertain.

Installation/version facts must come from scripts.apply/status, not constants added to a returned object. A declared version in metadata does not establish which code executed in the current document. Installation, injection and observed behavior are separate claims.

A tool's success flag describes execution. A verification's passed flag describes its supplied boolean expression. Neither establishes that the expression matches the user's requirement. Choose assertions from the actual task, inspect their results and preserve relevant existing behavior. Do not weaken a failing assertion merely to accept a regression.

Absence of a target before an action does not exercise the action. Report whether behavior was triggered, already satisfied or not tested. Container existence alone does not establish its contents, visibility or interactions. Determine relevant page states and lifecycle changes from observations; do not infer rendering behavior merely from a framework tag or application state from one optional CSS class.

Document readiness is not necessarily application readiness. A state observed after a delay does not establish when it first occurred or what happened between observations. Tool durationMs is the entire invocation, not DOM latency or a frame measurement. Aggregate layout changes alone do not establish the cause of an individual element's movement.

scripts.status.verification is the latest stored assertion, not an aggregate suite. It is null when unavailable. It does not track document navigation: recheck relevant behavior on the current page, and do not treat a later pass as proof that every earlier failure resolved. Earlier results remain in operation records.

## Logs and retained evidence

Connect before the action so native collection is active. Bookmark the last event seq, query after it, and paginate using the last returned seq. browser.events returns an ARRAY. Empty matching results only describe retained events; the buffer is limited to 2000 entries or about 2 MiB, including unrelated events. Do not claim full log coverage when results are capped or earlier events may have been evicted.

Classify Runtime.exceptionThrown by method, console errors by params.type, and Log entries by params.entry.level. Filtering only for the word error or script-specific keywords can omit relevant regressions. Installing a page error listener after an action cannot recover earlier exceptions.

Use causal comparisons only when necessary and restore the intended state afterwards. Clean up diagnostic effects. Screenshot references are not visual evidence when image input is disabled. Report observed facts and untested limits; stop after the requested work and relevant checks.

## Error semantics

| Evidence | Meaning / response |
| --- | --- |
| invalid_input | Correct the call using its documented signature. No automatic argument rewriting occurs. |
| http_timeout / http_network_error / aborted | HTTP may already have reached the server. Inspect effects before retrying; HTTP 4xx/5xx resolve normally with ok:false. Catch errors using code/details; name retains the code for compatibility. |
| request_too_large / response_too_large / http_busy | Respect the documented HTTP body/bridge/concurrency limits. No truncated body or implicit file is returned. |
| error.details.phase:"preflight", replCompleted:false | The repl output_file path/check failed before execution. Correct the destination; this code did not run. |
| error.details.phase:"output", replCompleted:true | Code completed and output_file saving failed. Preserve state and inspect effects before retrying. The error code still identifies conflict, size_limit or storage failure; do not repeat mutations to get output. |
| truncated:true with value.artifact | Full final JSON is saved under /artifacts/; only its head/tail preview is inline. Use Read/Grep or small fs.read ranges on value.artifact.path, without rerunning the original code. |
| output_save_failed warning | Execution completed, but automatic artifact persistence failed. Only a bounded preview is available; inspect retained state/evidence and do not repeat mutations. |
| unsupported_global | Check whether the code belongs in QuickJS or inside browser.evaluate. The available environments differ. |
| undefined_field / undefined_return warning | JSON lost an undefined value. Check property names and the returned expression, or return null intentionally. The operation may still have completed. |
| context_changed | Reacquire affected contexts/handles; their old identifiers are invalid. Same-document navigation does not necessarily replace the execution context. |
| debugger_detached | Reconnect explicitly with browser.connect. |
| Native protocol_error | Inspect the original browser message and official CDP contract. Check command/domain support; do not invent aliases. |
| page_exception / native exceptionDetails | Page code raised an exception. Helpers throw; native Runtime.evaluate retains exceptionDetails in its result. Existing Error text stacks are preserved once. Missing SyntaxError coordinates are appended as 1-based line/column; non-Error values use a bounded literal/browser preview. No duplicate details or automatic re-execution are added. |
| REPL compilation error | A reliable QuickJS position is mapped to user code and appended once as `(line N, column M)`, using the same 1-based/UTF-16 format as page syntax errors. Unknown columns or generated-wrapper positions are omitted. Runtime JSON.parse, host and page errors retain their original messages and codes. |
| timeout / interrupted / unknown | An action may already have taken effect. Inspect current state before repeating a mutation. Do not suppress the error and claim success. |
| passed:false | The supplied assertion failed. Diagnose the assertion and implementation against the original task. |

When paused, use native Debugger.evaluateOnCallFrame with its callFrameId. For iframe/Worker work use browser.contexts and the corresponding contextId/sessionId. The target remains the bound inspected tab and its owned child sessions.
