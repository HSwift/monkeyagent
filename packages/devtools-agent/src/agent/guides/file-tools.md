# File tool contract

The public interface follows Claude Code's Read/Write/Edit/Glob/Grep names and common parameters. There is no shell. Files are in the virtual workspace, not on the user's disk.

| Tool | Parameters | Behavior |
| --- | --- | --- |
| Read | file_path, offset?, limit? | offset is a 1-based LINE (default 1); limit counts lines (default/max 2000). Output content has line numbers; exclude those prefixes from Edit.old_string. Returns total_lines and next_offset when more remains. Long lines are shortened after 2000 characters; use REPL fs.read for character ranges. |
| Write | file_path, content | Creates a file or replaces its entire contents. Does not append/merge. Read an existing file first. |
| Edit | file_path, old_string, new_string, replace_all? | Exact replacement; preserve all whitespace. No regex/fuzzy matching. old_string must be nonempty and unique unless replace_all:true. |
| Glob | pattern, path? | Glob matching, default path /workspace. Supports **, *, ?, classes and braces. Returns newest files first, at most 1000 paths. |
| Grep | pattern, path?, glob?, type?, output_mode?, -i?, -n?, -o?, -A?, -B?, -C?, context?, head_limit?, offset?, multiline? | RE2 regex search. Default output_mode files_with_matches; content shows matching lines/context; count counts matching lines per file. offset is 0-based result pagination. -n defaults true; head_limit defaults 200, 0 requests all up to a 1000-entry cap. Supported types: js/ts/json/css/html/md; use glob otherwise. |

Write/Edit return {path, revision, size, updatedAt}; Edit also reports replacements. The harness remembers revisions from Read/Write/Edit and performs atomic revision checks. You do not provide expectedRevision. A stale revision fails with conflict even if a substring still matches: reread and reconcile human edits. A successful prior Write/Edit counts as observing the resulting file. Reopening/clearing a conversation resets that observation, so read before modifying existing files again.

Differences from a local CLI: text files only, under /workspace; /docs and /artifacts are read-only. No OS filesystem, .gitignore, PDF/notebook reads or background jobs. Grep uses browser-bundled RE2JS, without lookarounds/backreferences; multiline:true matches across lines and dot matches newlines. Large results are bounded or saved as artifacts. Glob/Grep are search tools, not Read: they do not satisfy read-before-write.

REPL fs methods remain the low-level API: fs.read offsets/limits count CHARACTERS, and fs.write/edit/remove/rename still accept explicit revisions. Prefer the named file tools for editing source; use fs for combined operations, renaming/removing, and reading long text artifacts in ranges.
