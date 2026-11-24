# DevTools Agent

独立运行在 Chromium F12 中的 Violentmonkey 脚本开发 Agent。模型调用、AI SDK loop、React 前端、IndexedDB 工作区、QuickJS Worker 和原生调试连接均属于本包；Monkey 提供脚本读取、保存、启停及版本读取适配器。设计依据见 [设计文档](../../docs/devtools-agent-design.md)。

## 在 Monkey 中使用

```sh
pnpm install
pnpm build:mv3
```

1. 在 Chromium 的扩展管理页开启开发者模式，加载仓库的 `dist-mv3/`。
2. 在 Monkey 扩展详情中开启 Chrome 的 **Allow User Scripts / 允许用户脚本**，以便 Monkey 注入脚本。
3. 打开需要修改的网页，再打开 F12，选择 **Agent**。窄的 DevTools 窗口可能将 Agent 放在更多面板菜单中。
4. 打开 Agent 设置，填写兼容 Chat Completions 的 API Base URL、模型 ID 和 API Key。Base URL 通常以 `/v1` 结尾，不包含 `/chat/completions`。
5. 描述需求，或导入已有脚本。Agent 可以写文件、安装脚本、刷新被检查的标签页并验证实际行为。

普通的 `pnpm build` 保留原 MV2 构建；Agent 只进入 `build:mv3`。生产包不需要本地服务、CDP WebSocket 或远程加载的脚本。

## 独立开发

普通 UI 预览：

```sh
pnpm agent:dev
# 打开 http://127.0.0.1:5173/panel.html
```

预览使用独立 MockScriptStore 和真实 IndexedDB/QuickJS/AI SDK，可开发对话和文件交互。真实网页调试需要扩展环境；预览不会伪造成功的浏览器调试结果。

最小测试扩展：

```sh
pnpm agent:build
pnpm --filter @monkeyagent/devtools-agent fixture
```

在 Chromium 加载 `packages/devtools-agent/fixtures/extension/`，然后打开目标网页 F12。它使用相同的 Controller、前端、Worker、WASM、CSP 和 debugger API，脚本仓库由 MockScriptStore 提供，不模拟 Monkey 的网页注入。

随宿主持续构建：

```sh
pnpm dev:mv3
```

该命令同时监听 Monkey 和 Agent 资源。修改后重新加载扩展并重新打开 F12；生产调试不依赖 Vite 服务。

## 数据与执行语义

- 工作区与 session 按站点（eTLD+1，包含公共后缀表中的私有域）隔离。同站点的子域、协议和端口共享当前文件、脚本绑定及 session 列表；每个 session 独立保存聊天和运行记录。IP 与 localhost 按主机名隔离。跨站导航会停止当前任务并切换到目标站点的工作区与 session，返回站点时恢复该标签页上次使用的 session。
- 站点解析优先使用浏览器 `chrome.publicSuffix.getDomain()`，接口不可用、没有结果或调用失败时使用随代码打包的 `tldts` 公共后缀规则（含私有域）兜底；解析无需联网，保留旧版 Chromium 和普通网页预览的支持。
- 工作区使用独立数据库 `monkeyagent-devtools-v1`，文件修改通过 IndexedDB 事务检查 revision。覆盖、编辑、删除需要最新修订。
- 旧版数据首次打开时自动迁移，保留 session ID、对话及当前文件；同站点同名且内容不同的文件保留为带 `.migrated-…` 后缀的副本。
- 人工编辑自动保存；遇到 Agent 并发修改保留草稿和远端版本。保存、安装、安装后修改和行为验证分别显示。Changes 只针对已安装或导入的油猴脚本，按脚本 ID 对比已保存版本与工作草稿。恢复先载入编辑器，显式安装并刷新后才影响网页。
- Files 抽屉点击“New file”后，可在弹窗底部通过横向“Upload file”按钮选择本地 UTF-8 文本文件（最大 2 MiB）。选择后默认路径为 `/workspace/<文件名>`，可修改后点击“Upload”保存并自动打开；不选择本地文件时，点击“Confirm”创建空文件。同名路径会提示更换路径，不会覆盖已有内容。
- 同一会话的 Agent 工具、手动 REPL 和安装操作共用串行队列。独立 DevTools 窗口绑定各自的 inspected tab；活动标签页变化不会改变操作目标。会话通过 Web Locks 防止被两个窗口同时执行。
- 输入框 Enter 发送、Shift Enter 换行；Ctrl/⌘ + `.` 可从任意视图停止执行，顶部也始终提供运行中的停止入口。文件树支持方向键和 Home/End 切换文件。
- 关闭 F12 结束执行。重新打开恢复文件、对话和记录，不重放工具。中断时已发出的操作可能已经生效，记录为 unknown，需要先检查状态。
- 每个标签页分别记住各站点上次选中的会话；其他标签页打开该会话不会抹掉这份选择。快速重开 F12 时等待原窗口释放会话锁。原标签页已关闭、tabId 改变时，优先恢复同 URL、其原标签页已不存在的可用历史；不会自动接管另一个仍打开的标签页的会话。会话正在另一个 DevTools 中使用时保留执行独占。
- 默认界面以对话为中心，顶部的“Files”“Changes”“Debug”分别打开对应抽屉，切换或收起后仍保留编辑草稿和调试输入。右上角“More actions”菜单中的“Clear context”会停止当前任务，清除本段消息、待发送要求和 REPL 临时状态，保留当前工作区文件、脚本绑定及模型设置。清空结果会持久化，后续模型请求不会携带旧对话；“New session”在当前站点下创建独立对话，继续使用该站点的共享文件。任务与工具记录保留用于检查操作结果，不会重新变成聊天消息。
- Files 目录树展示 `/workspace`、`/docs` 和 `/artifacts` 三个根，支持嵌套目录；`/source` 继续仅供工具按需读取，不出现在面板。文档和文本工件默认折叠，展开时单独加载目录元数据，点击文件才读取只读正文，可下载，工件保留分页。文档和工件目录缓存不进入会话快照；工件仅通过轻量变更标识触发展开列表更新，折叠或关闭时不重载。查看只读文件时，工作区文件新增不会打断当前阅读；跨站切换隔离目录与选中文件。文档列举直接使用打包索引，不扫描工作区。
- REPL 支持 await、显式 return 和 `state`。局部声明不跨调用保留；停止、超时或 Worker 异常重置内存状态。计算限制为 64 MiB，默认 15 秒，最多 60 秒。
- Agent 持续执行，直到模型结束工具调用或用户停止。运行中补充要求在下一步骤边界注入；模型提前结束时，未消费的要求保留在队列，可手动继续发送。
- 任务记录保存实际模型配置（不含密钥）、逐步结束原因、工具名、token 用量（由模型服务提供时）和终止错误。可恢复的工具参数错误不会把最终完成的整轮标为失败；原始连接错误不会被后续的“无输出”错误覆盖。旧版空消息 ID 会在读取时修复。
- 截图保存为 Blob 工件。启用图片能力后，SDK 将图片作为图像内容发给模型，工具文本和会话记录只保留引用。网络正文按需读取，协议输出有大小限制。
- API key 使用独立 `chrome.storage.local` 配置项，不写入工作区、REPL、模型提示或 Monkey 设置导出。普通网页开发预览使用该预览 origin 的 localStorage。
- 同一扩展中的独立模块不是独立权限主体。首版的 Monkey 外部修改检查是保存前重读，不提供与宿主编辑器之间的原子 CAS。

## 模型工具与 REPL

模型设置新增 **Auto-compact threshold (tokens)**，默认 **64000**，设为 **0** 关闭自动压缩；正数至少 1024。阈值按 system instructions、工具定义及历史消息的总输入估算，并参考最近一次模型返回的 input token 用量。它不是精确分词或自动识别模型窗口，请按实际模型窗口预留回复与摘要空间。

达到阈值后，在完整工具交互边界，用当前模型发起一次无工具的摘要请求，参考 [Codex 交接模板](https://github.com/openai/codex/blob/02390c8d8e39a9b72d12e04e83987d5eb6801310/codex-rs/prompts/templates/compact/prompt.md)保留目标与约束、已完成工作及验证、未完成任务和关键路径/工件。后续输入使用摘要、最近三组完整交互及必要时原样保留的最新用户要求；压缩期间补充的要求会进入下一次正常请求。摘要及原始历史覆盖边界按 session 持久化，刷新后继续使用；关闭自动压缩仍可复用已有摘要，Clear context 同时清除摘要。原始聊天记录保持完整，压缩不会重启 REPL、改写 state 或重放工具；刷新面板仍沿用原有 Worker 重建行为。

空摘要、摘要未缩小输入、保留内容仍超阈值或请求/保存失败时，继续使用原上下文，本轮不重复自动尝试。停止会取消尚在进行的摘要请求。状态栏显示压缩进度、前后 token 估算或失败提示；debug pack 保留摘要、边界与运行状态。

REPL 内置 `networks.status/list/get/requestBody/responseBody/getHAR`，直接复用 F12 Network 的 HAR 日志和原生正文读取。打开 DevTools 后仅订阅轻量事件，首次查询（包含 status）才读取当前 HAR 并建立索引，正文仍按需读取；首次查询前 F12 已保留的原生日志也可读取。不需要 start/connect，不修改录制、缓存或 Preserve log 设置。查询跟随 F12 Clear 和原生日志保留行为；同 URL 请求分别保留，正文不可用时报错，不重新请求。分页摘要限 16 KiB，详情桥接限 3 MiB JSON，完整正文限 2 MiB，较大正文可显式按字符范围读取（宿主取体上限 8 MiB）。标识是当前元数据版本的 opaque ID，不是 CDP requestId；数据变化后按 context_changed 重新列举。公共扩展 API 未暴露的录制控制、WS/SSE 消息流不在此伪造。完整契约见 [Network 指南](src/agent/guides/networks-api.md)。

`browser.evaluate` 的普通 Error 文本及现有堆栈原样保留。仅为缺少位置的 SyntaxError 补一次 1-based 行列，为非 Error 抛出值补字面值/有界浏览器预览（最多五个属性、2000 UTF-16 字符，标明省略/截断）。错误仍通过 `page_exception` 和单份 message 返回，不额外复制 description、stack 或整份 exceptionDetails，也不触发 getter 或重跑代码来扩展内容。

REPL 编译错误与 browser 的补充位置共用 `(line N, column M)` 格式：行列从 1 开始，列按 UTF-16 计数，缺失的列不补猜。QuickJS 的位置会还原 async 包装偏移并转换 Unicode 码点、CR/Unicode 换行差异；落在生成包装里的位置不映射为用户代码。已有位置/堆栈不重复追加。JSON.parse 等运行时错误、页面与宿主错误保留现有 message/code，不误标为 REPL 编译错误，也不重跑代码或增加重复错误字段。

REPL 新增内置 `http.request(absoluteHttpUrl, options?)`，由扩展侧原生 fetch 执行 HTTP/HTTPS 请求，使用已授予的 host 权限，不依赖页面 CORS 或调试器连接。采用 Promise 接口，返回完整的 `{status,statusText,ok,url,redirected,headers,body,base64Encoded,bodyBytes}` 数据对象；它是项目客户端，不兼容 Node `node:http` 的回调、流或 socket，也不返回原生 Response。Cookie 默认 omit，可显式 include；浏览器 Cookie 策略和服务端鉴权仍生效，不自动复用页面 localStorage/请求头。

HTTP 请求正文限 2 MiB UTF-8；响应限 2 MiB 解码字节、3 MiB 序列化 JSON；同一 Controller 最多四个并发请求。HTTP 4xx/5xx 正常返回 `ok:false`；超时、停止、网络和超限抛带 code/details 的错误。整体 REPL deadline 会取消未完成的 HTTP 请求，失败不自动重试。正文不自动截断或落盘；按需 `fs.write` 或使用 `repl.output_file`，沿用各自的大小/修订限制。具体字段、编码和边界见 [HTTP 指南](src/agent/guides/http-api.md)。

`/source` 按需挂载当前调试页面及 owned child targets 的 HTML/CSS/JS 和运行时脚本，复用 Glob/Grep/Read 与 fs.list/fs.read。先列举再使用返回的路径；来源元数据保留完整 URL、frame/session/script 身份，query 和导航代次不会互相覆盖。取源通过 DevTools/CDP，不额外 fetch URL。挂载只读、不自动持久化或列入默认文件面板；sourcemap 原始文件与 pretty-print 暂未支持。单文件限 8 MiB UTF-8，宿主缓存限 32 MiB、TTL 5 分钟；导航、断开或源码变更会失效。Grep 单次扫描源码限 8 MiB，结果中的 search_complete/skipped_count 明确区分“无匹配”和“未完整扫描”。

文件工具参照 [Claude Code SDK 的公开参数](https://code.claude.com/docs/en/agent-sdk/typescript#tool-input-types)和[工具行为](https://code.claude.com/docs/en/tools-reference)：`Read(file_path, offset?, limit?)` 按行读取，`Write(file_path, content)` 全量写入，`Edit(file_path, old_string, new_string, replace_all?)` 精确替换，`Glob(pattern, path?)` 匹配文件，`Grep(pattern, path?, …)` 搜索内容。现有文件先读后改，修订由 harness 自动跟踪；不要求模型传 expectedRevision。内部仍通过事务拒绝并发覆盖。具体差异和上限见 [文件工具指南](src/agent/guides/file-tools.md)。旧 files 调用只保留为历史兼容，不向模型展示。

Grep 可选 `char_context: 0–2000`，配合 `output_mode:'content'` 返回每个匹配点前后的字符窗口，适合压缩成长行的源码和大文本工件。结果包含字符位置、窗口起点、匹配长度和修订；可用 `fs.read` 扩大阅读。该模式与 `-o`、行上下文参数互斥，文本窗口最多 4000 字符，单页总输出受 16 KiB 预算与 head_limit 共同限制；有后续结果时通过 next_offset 继续。未传此参数时保留原有按行搜索行为。

`repl` 使用 `{code, timeout?, description?, output_file?}`，其中 timeout 是毫秒；继续执行 QuickJS JavaScript，不提供 Bash 或后台 shell。支持 `await sleep(ms)`，停止时取消。`browser.navigate(url, options)` 在发送导航命令前注册等待，避免先改 location 再等待产生的竞态；页面方法内的 timeoutMs 与整个工具的 timeout 分别控制各自期限。

可选 `output_file` 指定一个新的 `/workspace/` 文件：代码正常执行一次后，将最终 `return` 值保存为紧凑 JSON，工具仅返回 `{path, revision, size, updatedAt}`，减少模型上下文占用。内部函数取值与 `state` 保持不变；省略参数时沿用当前返回方式。字符串按 JSON 加引号，未定义返回值保存为 `null` 并保留 warning；已有文件不覆盖，文件额度沿用工作区限制。已知路径错误在执行前拒绝；若代码执行完但保存失败，错误带 `details: {phase:'output', replCompleted:true, output_file}`，不要为了补写输出重跑有副作用的代码。保存后的文件可通过 Files 抽屉、Read/Grep 或 fs.read 查看。

未传 `output_file` 时，REPL 最终 JSON 的直接回显阈值下调为 **8 KiB UTF-8**，超出后全文统一保存到只读虚拟路径 `/artifacts/`，返回 **2 KiB 首尾预览**、完整 artifact 引用/字节数、恢复提示和 `truncated:true`。其他工具保留原有 131072 个 UTF-16 字符阈值，复用相同保存链路；函数返回值和 `state` 不受影响。Read/Grep 可检索完整 artifact，`fs.list('/artifacts')` 可列举，`fs.read` 可按字符范围恢复。结果卡片可打开只读分页视图或下载全文。自动保存失败时保留预览并给 `output_save_failed` warning，明确执行已完成，不重跑代码。显式 `output_file` 路径及其失败规则保持。完整契约见 [工具输出说明](src/agent/guides/tool-output.md)。

```js
const page = await browser.evaluate('({ title: document.title, url: location.href })');
const installed = await scripts.apply('/workspace/main.user.js');
await scripts.setEnabled('/workspace/main.user.js', true);
await browser.reload({ waitUntil: 'domcontentloaded' });
const check = await browser.verify(
  '/workspace/main.user.js',
  'document.querySelector("#my-button")?.textContent === "Ready"',
);
return { page, installed, check, screenshot: await browser.screenshot() };
```

开发任务先通过 `Read` 读取 `/docs/agent-guide.md`，再按需读取 `/docs/file-tools.md`、`/docs/browser-api.md`、`/docs/script-api.md`。指南以独立 Markdown 随扩展打包，覆盖最小改动、动态 DOM、解析期间保留父容器、相邻内容不被破坏、失败断言的诊断及及时结束任务。提示词要求问候直接回答，并禁止在图片输入关闭时声称看过截图。`browser.send` 保留当前标签页及其 iframe/Worker 子会话的通用协议能力，Target 的发现和附加由 BrowserSession 管理。刷新后重新获取上下文、对象句柄和暂停调用帧。

调试失败时按需读取 `/docs/debugging-workflow.md`，说明日志范围、错误语义和证据边界。`evaluate/navigate/reload/events` 等属于我们自己的 bridge，可改进用法；`browser.send(method, params, sessionId?)` 则保留原生 CDP 命令、参数和返回字段。原生 `Runtime.evaluate` 返回 `{result, exceptionDetails?}`，便捷 `browser.evaluate` 返回页面值并抛出页面异常；不要混用两者的契约。具体评估和改动边界见[首份轨迹评估](../../docs/agent-debug-trace-1-review.md)。

工具输入和自有 bridge 选项采用严格校验，拼错参数不会被静默忽略。REPL 返回的 `warnings` 提示因 JSON 序列化而丢失的 undefined 值，不改变 JavaScript 属性访问语义或自动改写调用。`scripts.apply/status` 提供从宿主快照读取的版本及修订；status 的 verification 明确返回对象或 null，外部修改、禁用或工作区修订不符时不会返回旧的通过记录。它仍只代表最近一次断言，未实现验证套件或导航关联。

后续改动以通用的工具契约、可靠性和诊断为边界。任务相关的选择器、断言和业务判断由模型负责；不提供任务模板，不按特定模型增加特例或隐式纠错。

油猴脚本版本在宿主保存入口统一记录，Agent 的 scripts.apply、油猴编辑器保存及脚本安装/更新共用这条链路。只有代码变化且保存成功才产生版本，相同代码和启停不重复记录；每个脚本保留最近 20 个版本，记录代码、时间、来源和声明的 @version。旧脚本第一次更新会先补存更新前的代码。Changes 的“Restore to editor”只载入草稿，安装时继续检查外部修改；不复写未观察到的油猴编辑。普通工作区文件不保存历史快照，仅保留当前内容和并发修订号。Agent 数据库升级到 v3 时删除旧 revisions 表、会话文件基线及重复安装代码，保留当前文件、会话、上下文摘要、安装绑定及操作记录。旧工作区草稿历史不会被冒充为已安装的脚本版本。

## 内部调试导出

### 调试包（推荐）

在 Agent 的 **调试** 抽屉点击 **Export debug pack**，下载当前 session 的 `monkeyagent-debug-<站点>-<时间>.zip`，用于离线排查和改进扩展：

| 路径 | 内容 |
| --- | --- |
| `manifest.json` | 格式版本、扩展版本、导出范围、数量统计和已知局限 |
| `settings.json` | provider、地址、模型、图片能力和自动压缩阈值（不含 API Key） |
| `agent/` | 按导出时状态重建的完整 system prompt、工具定义（JSON Schema）与 `/docs` 指南 |
| `session/` | session 元数据、对话、发送给模型的消息、任务、全部工具调用、REPL 历史（区分手动/Agent）、可读 `transcript.md` |
| `workspace/` | 脚本绑定、当前文件（按原路径保存为真实文件）、文本工件 |
| `browser/` | 被检查的标签页，以及内存中的 CDP 事件缓冲（控制台、日志、网络） |

截图不导出。API Key、常见认证字段、Bearer 令牌和 URL 中的认证信息会被遮盖；脚本与网页内容仍需检查后再分享。实现见 [src/debug/](src/debug/)。

### Service Worker 控制台脚本

面板无法打开时的备用方式：在 `chrome://extensions` 找到 Monkey，开启开发者模式，点击扩展的 **Service Worker / 服务工作线程** 检查入口，在其 Console 粘贴运行 [export-debug-data.js](scripts/export-debug-data.js) 的全部内容。成功后 JSON 已进入剪贴板，粘贴保存为 `monkeyagent-debug.json`。

脚本默认导出最近使用的 session，并打印 session ID、标题和目标网址列表。需要指定另一段任务时，将脚本顶部 `sessionId` 改为表格中的对应 ID 再执行。它只读当前 Agent 数据库，导出该 session 的对话、任务、工具输入输出与错误，以及所属站点的共享当前文件、脚本绑定和文本工件；不读取 Monkey 的其他数据库。模型配置仅导出当前 provider、地址、模型、图片能力和自动压缩阈值，不导出 API Key。常见认证字段、URL 中的认证参数以及意外出现在文本中的当前模型密钥会被遮盖；脚本与网页内容仍需检查后再分享。

原始模型 HTTP 流及完整浏览器事件没有持久化；旧任务还缺少逐步 token 用量。截图只导出元数据。需要保留当前内存中的网页日志与网络事件时，在关闭 F12 或重新加载扩展前，先在 Agent 的调试 REPL 执行以下代码，再按上述方法导出，事件文件会随工作区一起带出：

```js
const events = [];
let after = 0;
for (;;) {
  const batch = await browser.events({ after, limit: 200 });
  if (!batch.length) break;
  events.push(...batch);
  after = batch[batch.length - 1].seq;
}
const path = `/workspace/debug-events-${Date.now()}.json`;
await fs.write(path, JSON.stringify(events));
return { path, count: events.length };
```

浏览器缓冲区最多保留最近 2000 条、约 2 MiB 的事件，已经淘汰或关闭 F12 丢失的事件无法补回。导出脚本本身不会修改已有文件或任务记录；上面的可选 REPL 命令会新建一个事件文件。

## 检查与验收

```sh
pnpm --filter @monkeyagent/devtools-agent check
pnpm agent:test
pnpm test
pnpm --filter @monkeyagent/devtools-agent exec playwright install chromium
pnpm agent:test:browser
```

浏览器测试加载实际构建的扩展，使用隔离的 Chromium profile。模型端由本地 HTTP 测试服务器产生标准流式工具调用，不依赖真实模型账户或付费请求。Monkey 注入测试加载实际 `dist-mv3`，在测试 profile 中启用用户脚本权限；不会修改用户的浏览器配置。

| 测试                    | 验证内容                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| Vitest                  | 原子修订冲突、只读路径、工作区隔离、安装状态、外部脚本冲突、异步 REPL、死循环中断、工具顺序 |
| agent.spec.ts           | 前端发起实际 SDK 多步循环、文件写入、网页调试、消息恢复、截图模型输入                       |
| panel.spec.ts           | CodeMirror 编辑、安装、模型配置、原生求值、会话恢复                                         |
| browser-session.spec.ts | 原生 CDP 透传、参数校验、序列化诊断、iframe/Worker、刷新与旧句柄、截图和显式重连             |
| monkey.spec.ts          | 宿主保存/历史适配器、同名冲突、实际 `document-start` 与 GM API、交互、启停及编辑器保存历史     |
| resilience.spec.ts      | 停止、取消排队工具、超时、不重放、人工草稿冲突、脚本版本恢复、窄屏                              |
| runtime.spec.ts         | 实际 F12 Agent 面板、MV3 CSP/WASM、原生面板切换、停靠模式和关闭清理                         |
| closed-loop.spec.ts     | 实际 F12 Agent 完成编写、Monkey 安装、原生鼠标交互、失败验证和修复                          |
| steering.spec.ts        | 步骤边界接收补充要求、消息持久化、停止模型流与密钥不进入模型请求正文                        |
| compaction.spec.ts      | 阈值设置、长任务摘要、完整工具边界、排队要求、状态不重放、刷新复用与停止摘要                  |
| sessions.spec.ts        | 同站点共享文件与会话列表、跨站隔离与导航恢复、并发修订、会话独占                                |
| session-restore.spec.ts | 快速重开等待会话锁、每标签页记住选择、tabId 变化后的历史恢复及其他窗口的占用保护                 |
| script-changes.spec.ts  | 脚本 ID 版本隔离、草稿不产生版本、相同保存去重、历史载入与显式安装、重载恢复                      |
| context.spec.ts         | 清空对话并持久化、保留文件与脚本绑定、取消运行和排队要求、后续模型请求排除旧消息              |
| harness.spec.ts         | Claude Code 风格文件工具、错误恢复、精简结果、导航等待、消息 ID、逐步用量与终止错误持久化 |
| debug-export.spec.ts    | 内部控制台导出、工作区隔离、工具失败与修订、密钥和认证字段遮盖、原数据保留                    |

前端组件的开源来源和许可证见 [THIRD_PARTY.md](THIRD_PARTY.md)。构建会生成 `THIRD_PARTY_LICENSES.txt` 并随扩展发布。
