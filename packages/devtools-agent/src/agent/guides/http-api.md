# Extension HTTP client

The REPL provides a built-in, frozen `http` module with one Promise-based method:

```js
const response = await http.request('https://api.example.com/items', {
  method: 'GET',
  headers: {Accept: 'application/json'},
  timeoutMs: 15000
});
if (!response.ok) return {status:response.status, body:response.body};
const data = JSON.parse(response.body);
state.items = data.items;
return {status:response.status, count:data.items.length};
```

Call it directly alongside fs/browser/scripts. There is no import, require, npm, node:http, global fetch, Node socket, Agent, callback or stream interface. This is a project-defined HTTP client, not Node HTTP compatibility or a native Response object. `response.json()`/`text()` do not exist: use JSON.parse(response.body) for text JSON.

## Execution and credentials

Requests run in the extension host using native fetch, without page evaluation or attaching the debugger. Cross-origin requests use the extension's granted host permissions. They are not made with the inspected page's origin, JavaScript state or localStorage tokens. Relative URLs are rejected. Page-origin/CORS behavior remains available through page fetch inside browser.evaluate; no automatic fallback switches between these environments. Plain web development previews lack extension host privileges. Extension HTTP is not captured in the inspected tab's browser.events/Network buffer; retain needed evidence explicitly in the REPL result, state or workspace.

credentials defaults to `omit`: cookies are not sent or accepted automatically. Set `credentials:'include'` explicitly to use the browser's eligible cookie store. Cookie/SameSite/partitioning policies and server authentication still apply; this is not a promise of the page's exact login state. Only make requests authorized by the task; POST and other server actions can have irreversible effects. The client never retries automatically, including after cancellation or output-saving failure.

## Signature and options

`http.request(absoluteHttpUrl, options?)` accepts exactly these fields; unknown fields, extra arguments and wrong types fail before dispatch.

| Field | Contract |
| --- | --- |
| URL | Absolute HTTP(S), at most 8192 UTF-16 units, without embedded username/password. |
| method | GET (default), HEAD, POST, PUT, PATCH, DELETE or OPTIONS. Uppercase only. GET/HEAD reject any body, including an empty string. |
| headers | Record of string values. Browser Headers validation and normalization apply. Browser-controlled/unsupported headers such as Cookie, Origin, Referer, Host, Content-Length, User-Agent, Sec-* and Proxy-* are rejected rather than silently dropped. |
| body | UTF-8 string only, at most 2 MiB encoded bytes. No implicit JSON/form conversion. For JSON use JSON.stringify and an explicit Content-Type header. Binary uploads are not supported. |
| credentials | omit (default) or include. |
| redirect | follow (default) or error. Native redirect handling may change the method/drop sensitive headers as appropriate; it is separate from retrying a request. |
| timeoutMs | Integer 1–60000, default 15000. Covers headers and body reading; cannot extend the enclosing repl deadline. |

At most four requests per Controller may be in flight, including Promise.all. A fifth fails with http_busy before dispatch; await outstanding requests before starting more.

## Response data

The Promise resolves after the complete response body has been read:

```json
{"status":200,"statusText":"OK","ok":true,"url":"https://api.example.com/items","redirected":false,"headers":{"content-type":"application/json"},"body":"{\"items\":[]}","base64Encoded":false,"bodyBytes":12}
```

The return shape is fixed for small and large responses. Headers are the browser-exposed, normalized response headers, not raw wire headers. Text MIME types (text/*, JSON/+json, XML/+xml, JavaScript, form-urlencoded, SVG) are decoded as UTF-8, matching fetch Response.text; charset labels do not select another decoder. Binary or missing/unrecognized MIME types use base64 with base64Encoded:true. Empty responses, including HEAD/204, have body:"", bodyBytes:0 and base64Encoded:false. bodyBytes counts actual decoded transport bytes before text/base64 conversion, not Content-Length or compressed wire bytes.

HTTP 401/422/500 resolve normally with ok:false. Request/network/permission failures, cancellation and resource limits reject the Promise. Check status/ok before parsing an assumed success schema.

## Limits, cancellation and persistence

A response is limited to 2 MiB of bytes from the decoded fetch body stream, and 3 MiB of serialized UTF-8 JSON for the whole response crossing into QuickJS. JSON escaping can hit the second limit earlier. The request is aborted on streaming overflow; neither limit returns a truncated body, file reference or summary. These limits are separate from browser.send's 256 KiB protocol limit, QuickJS's 64 MiB memory limit, workspace file limits and final tool output handling. Keep only needed fields in state and return a summary when possible.

Stop, enclosing REPL timeout, invocation end/error and Controller/session disposal cancel outstanding requests. A same-site page navigation does not itself cancel extension-origin HTTP; a site/session switch that stops the REPL does. Cancellation cannot undo server actions already performed. No request is replayed automatically.

Errors expose code/message and optional details in both REPL catch and the outer tool error. Host error.name retains its code for compatibility. HTTP body/network errors include details.environment:"http", url and method. Common codes: invalid_input, request_too_large, response_too_large, http_timeout, http_network_error, http_busy, aborted and the outer REPL timeout. A network error does not prove the server received nothing.

Explicit persistence: fs.write(path,response.body) saves the raw text/base64 string under workspace rules; repl.output_file saves the final return value as JSON and returns file metadata. Neither bypasses the input or workspace limits. If saving fails after a request completed, inspect state and effects before retrying. Without output_file, final REPL JSON above 8 KiB is automatically saved under /artifacts/ with a 2 KiB preview and the full-result path. The HTTP function's response and state remain complete; no HTTP request is repeated. See /docs/tool-output.md for recovery and storage-failure behavior.
