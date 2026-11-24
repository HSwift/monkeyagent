# Tool output and saved artifacts

The interpreter's functions return ordinary complete values within their own input/VM limits. The outer tool applies an output budget only after execution has completed. It does not change variables, function return types, calculations or `state`, and never reruns code to save or recover output.

## Automatic large-result saving

Without an explicit `output_file`, a final REPL return value whose compact JSON exceeds **8192 UTF-8 bytes (8 KiB)** is saved in full under `/artifacts/`. Exactly 8192 bytes stays inline. Other tools retain their existing threshold of 131072 UTF-16 characters of JSON and use the same artifact-saving path when exceeded. These thresholds apply to the serialized value; the tool envelope, references and warnings add metadata.

For an oversized value, the outer tool returns:

```json
{"success":true,"value":{"preview":"head…tail","artifact":{"id":"…","path":"/artifacts/result.json-…","mimeType":"application/json","size":80000},"notice":"Full JSON result saved at artifact.path; use Read/Grep or small fs.read ranges."},"artifacts":[{"id":"…","path":"/artifacts/result.json-…","mimeType":"application/json","size":80000}],"truncated":true,"durationMs":10}
```

The preview contains at most **2048 UTF-8 bytes (2 KiB)** including its omission marker, divided between the head and tail without splitting Unicode characters. It is incomplete text, not a complete JSON value to parse. The saved artifact contains the exact compact JSON of the final value, not the ToolResult envelope, all intermediate host results or the entire state. Strings are JSON-quoted; undefined follows the existing null/warning behavior. `artifact.size` counts saved UTF-8 bytes. Existing image references remain available separately.

No new request or execution is required to recover omitted content. Use the returned path:

```js
// REPL: read a small character range without spilling the read result again.
return await fs.read('/artifacts/result.json-<returned-id>', {offset:40000,limit:2000});
```

Use the actual returned path, not the placeholder above. Read uses 1-based line ranges; fs.read uses 0-based UTF-16 character ranges. For one-line JSON, use Grep `{path,pattern,output_mode:'content',char_context:200}` to find a field/marker in the full artifact, then read ranges around its returned offset. Ordinary Grep and Read also operate on the full text snapshot, beyond its first 32000 characters, while retaining their output limits. Returning a large fs.read result through REPL is subject to the same 8 KiB final-output budget, so request small ranges or return selected fields/counts.

`fs.list('/artifacts')` and Glob `{path:'/artifacts',pattern:'**/*'}` list this workspace's text/JSON artifacts without loading their bodies. The default workspace listing remains focused on workspace files/docs. Binary artifacts keep their image/download references. Artifacts are read-only through fs and file mutation tools; copy data to /workspace before editing. Artifacts persist in the site's IndexedDB workspace and survive a panel reload; their references belong to recorded tool results. The result card's file link opens a read-only viewer with 32000-character pages and a full-file download.

## Saving errors

If automatic artifact saving fails, execution still reports success with `truncated:true`, the bounded preview and an `output_save_failed` warning. It does not claim a file was saved or return a nonexistent path. The full omitted value may be unavailable unless the program retained it in state or another file. Inspect existing state/evidence; do not repeat mutations merely to recover output. No fallback silently writes a different workspace file. Ordinary execution/input/serialization failures retain their existing error behavior.

## Explicit output_file

`repl.output_file` retains its explicit NEW `/workspace/` destination and returns only file metadata. It can save a small or large final value intentionally; automatic spilling is not involved because the returned metadata is small. Existing conflict/size/preflight/output-stage rules remain, and a failed explicit save is not redirected to /artifacts. This parameter is separate from automatic large-result storage. See /docs/browser-api.md for its full contract.

Automatic artifacts do not bypass http/network/source input limits, QuickJS's memory/deadline limits or browser storage capacity. Debug exports retain their existing text-artifact limit of 2 MiB per artifact, marking larger files omitted from the export; the original saved artifact remains accessible in the workspace. Older conversation results are not rewritten.
