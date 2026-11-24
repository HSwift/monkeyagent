# F12 Network REPL API

`networks` reads the inspected tab's existing F12 Network log through `chrome.devtools.network`. Lightweight event subscriptions start when DevTools opens, before the Agent panel is shown. The first query (including status) lazily reads the current HAR and builds its index; opening DevTools or receiving events does not load HAR metadata or response bodies. Records that F12 still retains from before the first query remain readable. There is no start/stop step or debugger attachment. Reads do not change F12 recording, cache, throttling, Preserve log or request blocking. New HTTP requests use `http.request`; historical network reads never fetch or replay a URL.

## Methods

```js
await networks.status();
await networks.list({urlFilter:'/api/', methods:['GET'], types:['fetch'], statusCodes:[200], offset:0, limit:50});
await networks.get(id);
await networks.requestBody(id);
await networks.responseBody(id, {offset:0, limit:32000});
await networks.getHAR();
```

All functions return ordinary Promises with JSON data. Unknown fields and extra arguments are rejected. No method implicitly saves data or replaces its return value with a file reference.

`status()` returns `{available:true,provider:'devtools',observation:'automatic',recordingState:'managed-by-devtools',requestCount,revision,observedAt,eventsObserved,lastFinishedAt,lastNavigationUrl}`. Times are epoch milliseconds except HAR timestamps. `eventsObserved` counts native completed-request notifications since this DevTools document started; it is not the current log length and does not reset on Clear. Last event/navigation values are null until observed. The public API does not expose the F12 recording button state: `available:true` means the API is available, not proof that recording is enabled. In ordinary web previews or standalone extension pages without the native DevTools API, status returns `{available:false,provider:'devtools',reason:'devtools_network_unavailable'}` and other methods reject with `networks_unavailable`.

`list(options?)` returns `{requests,total,offset,nextOffset,hasMore,revision,observedAt,provider:'devtools'}`. Each summary has `{id,url,urlTruncated,method,type,status,mimeType,startedAt,durationMs,transferBytes,error}`. Missing Chrome-specific type/transfer/error fields are null; HAR unknown timing values retain their native meaning. Summaries do not invent a finished flag: a HAR entry can still be in progress, and status 0 alone is not proof of failure.

- `urlFilter`: literal, case-sensitive URL substring, maximum 8192 characters. It is not a regex or the F12 filter expression language.
- `methods`: up to 32 method names, case-insensitive, e.g. `['GET','POST']`.
- `types`: up to 32 native resource types, case-insensitive, e.g. `['xhr','fetch']`.
- `statusCodes`: up to 1000 exact integers from 0 to 999. An empty filter array matches nothing.
- `offset`: 0-based position in the filtered native HAR order, default 0.
- `limit`: maximum entries, default 50, range 1–200. The 16 KiB JSON page budget can reduce the returned count. Follow `nextOffset`, not `offset + limit`.

Summary URLs are limited to 2000 UTF-16 characters with `urlTruncated:true`; `get(id)` retains the full URL. A single summary exceeding the page budget causes `network_result_too_large`, rather than an empty page with no progress.

Each query refreshes from native `getHAR`, so clearing the F12 log is reflected even without a notification. Preserve log, navigation and native recording controls determine which requests are retained. The API log is not guaranteed to match a visible UI text/type filter. Requests made before DevTools opened or while recording was disabled may be absent; an empty log does not prove no requests occurred.

`revision` identifies the ordered metadata-version IDs. The log can change between pages: compare revisions and restart pagination if a consistent enumeration matters. IDs are opaque to this Controller, not CDP requestIds, URL keys or durable database IDs. Metadata changes during loading can invalidate an ID. Identical HAR entries receive distinct IDs; when the number of identical entries changes, that entire group is invalidated because public HAR fields cannot identify which duplicate changed. After `context_changed`, relist. Do not pass these IDs to `browser.responseBody` or CDP commands.

`get(id)` returns `{id,entry}` with the native HAR entry's fields, preserving request/response headers, cookies, queryString, postData, timings and available Chrome extensions such as `_initiator`, `_resourceType`, `_priority`, `_transferSize` and `_error`. There is no extra normalized copy of those details. In-progress metadata can change between reads.

`requestBody(id)` returns `{postData: entry.request.postData ?? null}`. Native postData can include mimeType, text or params/file metadata. Null means HAR did not provide postData; it is not proof that the original request had no body. This API does not reconstruct uploaded file bytes.

`responseBody(id, options?)` invokes that native request object's `getContent` on demand and returns `{body,base64Encoded,offset,totalLength,truncated}`. Text stays text; native base64 stays base64. Without range options, the complete encoded body is returned or an explicit limit/unavailable error is raised. With either range option, offset counts 0-based UTF-16 characters in the returned text/base64 string; limit defaults to 32000 and accepts 1–64000. Ranges of base64 count encoded characters, not decoded bytes, and can split a base64 quartet; join ranges before decoding. Text ranges can split a surrogate pair. `totalLength` counts the full encoded string's UTF-16 characters. `truncated` means this result is a partial range. Neither a missing nor a pending/evicted body is reconstructed with a new request.

`getHAR()` returns the native HAR **log object** `{version,creator,pages,entries,...}`, not `{log:...}`. It does not call getContent for every response. Native content fields are retained if present; this is not a full-body HAR export. For a standard HAR file envelope, explicitly wrap it:

```js
const log = await networks.getHAR();
await fs.write('/workspace/scratch/network.har', JSON.stringify({log}));
return {entries: log.entries.length};
```

Workspace file limits and revision rules apply. Alternatively set the repl tool's `output_file` and return `{log: await networks.getHAR()}` to save only the final result. If output saving fails after code ran, do not repeat earlier mutations. Choose only needed data for return or persistence; headers and bodies can contain credentials and site data.

## Limits and lifecycle

The native metadata snapshot is limited to 10000 entries / 32 MiB serialized JSON. An oversized log fails with `network_log_too_large`; use F12 Clear to reduce the retained log if appropriate. UI filters and list filters do not shrink the native HAR metadata read. Individual `get`, `requestBody`, `getHAR` and response results are limited to 3 MiB JSON across the QuickJS bridge; oversized results fail with `network_result_too_large`.

A complete response body is limited to 2 MiB UTF-8 bytes of the encoded string; use explicit ranges for larger bodies. Native body snapshots are limited to 8 MiB of encoded UTF-8 data even for range reads, with a 32 MiB host cache, five-minute TTL and least-recently-used eviction. These limits bound host/VM resources, not browser retention. F12 can discard content independently. Clearing/removing records invalidates cached bodies; navigation drops body snapshots while preserving whatever metadata F12 retains. Closing DevTools releases subscriptions and snapshots. Native callback reads time out after 15 seconds. Stop and the REPL deadline cancel the caller's wait; they do not cancel or replay the inspected page's request. No read retries automatically.

This interface exposes native HAR metadata and available bodies. The public DevTools extension network API does not expose recording/clear/throttling/interception controls or WebSocket/SSE message streams. Those are not fabricated here. Existing raw `browser.events`, `browser.responseBody(requestId,sessionId?)` and explicit `browser.send` keep their CDP contracts and separate capture lifetime.

## Example

```js
const page = await networks.list({urlFilter:'/api/',types:['fetch','xhr'],limit:20});
const row = page.requests.find(r => r.status === 200);
if (!row) return {matches:page.total,more:page.hasMore};
const response = await networks.responseBody(row.id);
if (response.base64Encoded) return {id:row.id,note:'binary body'};
const data = JSON.parse(response.body);
state.lastResponse = data;
return {id:row.id,keys:Object.keys(data)};
```

Native reference: [chrome.devtools.network](https://developer.chrome.com/docs/extensions/reference/api/devtools/network).
