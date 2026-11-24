# File tool contract

The public interface follows Claude Code's Read/Write/Edit/Glob/Grep names and common parameters. There is no shell. Files are in the virtual workspace, not on the user's disk.

| Tool | Parameters | Behavior |
| --- | --- | --- |
| Read | file_path, offset?, limit? | offset is a 1-based LINE (default 1); limit counts lines (default/max 2000). Output content has line numbers; exclude those prefixes from Edit.old_string. Returns total_lines and next_offset when more remains. Long lines are shortened after 2000 characters; use REPL fs.read for character ranges. |
| Write | file_path, content | Creates a file or replaces its entire contents. Does not append/merge. Read an existing file first. |
| Edit | file_path, old_string, new_string, replace_all? | Exact replacement; preserve all whitespace. No regex/fuzzy matching. old_string must be nonempty and unique unless replace_all:true. |
| Glob | pattern, path? | Glob matching, default path /workspace. Supports **, *, ?, classes and braces. Returns newest files first, at most 1000 paths. |
| Grep | pattern, path?, glob?, type?, output_mode?, -i?, -n?, -o?, -A?, -B?, -C?, context?, char_context?, head_limit?, offset?, multiline? | RE2 regex search. Default output_mode files_with_matches; content shows matching lines/context; count counts matching lines per file. Optional char_context selects one character window per occurrence in content mode. offset is 0-based result pagination. -n defaults true in line mode; head_limit defaults 200, 0 requests all up to a 1000-entry cap. Supported types: js/ts/json/css/html/md; use glob otherwise. |

Write/Edit return {path, revision, size, updatedAt}; Edit also reports replacements. The harness remembers revisions from Read/Write/Edit and performs atomic revision checks. You do not provide expectedRevision. A stale revision fails with conflict even if a substring still matches: reread and reconcile human edits. A successful prior Write/Edit counts as observing the resulting file. Reopening/clearing a conversation resets that observation, so read before modifying existing files again.

Differences from a local CLI: editable text files live under /workspace; /docs, /source and /artifacts are read-only. No OS filesystem, .gitignore, PDF/notebook reads or background jobs. Grep uses browser-bundled RE2JS, without lookarounds/backreferences; multiline:true matches across lines and dot matches newlines. Large results are bounded or saved as artifacts. Glob/Grep are search tools, not Read: they do not satisfy read-before-write.

REPL fs methods remain the low-level API: fs.read offsets/limits count CHARACTERS, and fs.write/edit/remove/rename still accept explicit revisions. Prefer the named file tools for editing source; use fs for combined operations, renaming/removing, and reading long text artifacts in ranges.

Large final tool results are saved under read-only /artifacts/. Use the returned artifact.path with Read/Grep; both inspect the full text snapshot rather than the first fs.read preview. For one-line JSON, Grep character windows locate content in the omitted middle. fs.list('/artifacts') or Glob({path:'/artifacts',pattern:'**/*'}) lists text/JSON artifacts; default listings do not enumerate them. fs.read ranges retain default 32000/max 64000 characters, but returning a range through REPL also uses its 8 KiB output budget: choose limit:2000 or return selected fields. See /docs/tool-output.md.

## Page sources

Discover the inspected page's loaded HTML/CSS/JS and runtime scripts with Glob({path:"/source",pattern:"**/*.js"}) or fs.list('/source'). Use returned paths; query variants, frames, scripts and navigation generations have distinct identities. Metadata includes sourceUrl, kind, provider, frameId/sessionId/scriptId when available, sourceMapURL when supplied, availability and revision. size:-1 means the decoded length is unknown until read. Unread revisions identify index entries; successful reads use SHA-256 text revisions.

Grep({path:"/source",pattern:"targetName",output_mode:"content",char_context:200}) searches source on the host. Then Read a line range or fs.read(path,{offset,limit}) for a 0-based UTF-16 character range (default 32000, max 64000). fs.read reports totalLength and truncated; Read retains line semantics. Compare revisions when continuing a search. HTML source is a browser resource, not the current DOM; inspect live DOM with browser.evaluate.

The mount is read-only and ephemeral. Bodies are loaded on demand from DevTools/CDP, without an Agent URL fetch fallback. Compiled JS uses Debugger.getScriptSource; other resources prefer the frame-unambiguous DevTools resource API, then CDP Page. Chromium's resource backend may itself refill missing resource bodies; this is not a guarantee of offline/cached-only reads. Sources belong to the inspected tab and owned child targets. Unavailable, binary or oversized bodies fail explicitly. Source maps are metadata only: original TS/Vue files and pretty-print views are not reconstructed. Default fs.list(), Files UI and system instructions do not enumerate the mount. Its cache is not exported automatically; explicitly returned/saved excerpts can appear in conversation and debug records.

One source is limited to 8 MiB decoded UTF-8; host text cache is at most 32 MiB with a 5-minute TTL. Navigation, reload, disconnect, source edits and target changes invalidate paths/cache. After context_changed, list again. Grep scans at most 8 MiB of source per call and checks a 30-second deadline between files. Source searches add search_complete, scanned_bytes, skipped_count and a bounded skipped sample (file_path/reason). total_matches covers scanned files only. An empty result with search_complete:false cannot establish absence: narrow the path and inspect skipped_count even if the sample is shorter. Cancellation/context changes abort instead of reporting a false negative.

## Character windows for long or minified text

Use Grep with output_mode:"content" and char_context:200 to see up to 200 characters before and after each match instead of the first 2000 characters of a matching line. char_context is an integer from 0 to 2000; 0 requests only the matched text and positions. It requires content mode and cannot be combined with -o/-A/-B/-C/context, even when those options are 0 or false. Existing searches are unchanged when char_context is omitted.

```json
{"pattern":"targetName","path":"/workspace/bundle.js","output_mode":"content","char_context":200}
```

The result has output_mode_detail:"char_window". Each entry contains file_path, revision, offset, window_start, match_length, text, is_match:true and truncated. offset/window_start/match_length use 0-based UTF-16 string units, matching JavaScript slice and fs.read. The window is literal source text, with no line-number prefixes. Line-number flag -n does not affect this view. Multiple matches on one line produce separate entries; total_matches counts occurrences. Without multiline:true, matches remain scoped to individual lines, although their surrounding character windows may cross line breaks.

Each text window is at most 4000 characters and may be shorter to fit a 16 KiB serialized UTF-8 result budget. Entry.truncated means that particular window was shortened: use fs.read(file_path,{offset:window_start,limit:...}) to read more. Compare the returned revision; rerun the search if the source changed. Text artifacts are searched in full on the host; fs.read retains its existing range limits. A single match whose metadata alone cannot fit fails with size_limit.

Top-level truncated means more matching entries remain, separately from entry.truncated. Continue with the returned next_offset as the Grep input offset; truncation_reason is output_budget or head_limit. head_limit still caps each page, and 0 still means at most 1000 entries subject to the byte budget. A page beyond the end includes a message when matches exist; a genuine no-match result has total_matches:0. Grep still does not satisfy read-before-write even though it exposes the source revision.
