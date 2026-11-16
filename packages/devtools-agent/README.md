# DevTools Agent

独立运行在 Chromium F12 中的 Violentmonkey 脚本开发 Agent。模型调用、AI SDK loop、React 前端、IndexedDB 工作区、QuickJS Worker 和原生调试连接均属于本包；Monkey 只提供四个脚本操作。设计依据见 [设计文档](../../docs/devtools-agent-design.md)。

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

- 工作区使用独立数据库 `monkeyagent-devtools-v1`，文件修改通过 IndexedDB 事务检查 revision。覆盖、编辑、删除需要最新修订。
- 人工编辑自动保存；遇到 Agent 并发修改保留草稿和远端版本。保存、安装、安装后修改和行为验证分别显示。恢复差异基线会创建新修订，需要再次安装才能影响网页。
- 同一会话的 Agent 工具、手动 REPL 和安装操作共用串行队列。独立 DevTools 窗口绑定各自的 inspected tab；活动标签页变化不会改变操作目标。会话通过 Web Locks 防止被两个窗口同时执行。
- 输入框 Enter 发送、Shift Enter 换行；Ctrl/⌘ + `.` 可从任意视图停止执行，顶部也始终提供运行中的停止入口。文件树支持方向键和 Home/End 切换文件。
- 关闭 F12 结束执行。重新打开恢复文件、对话和记录，不重放工具。中断时已发出的操作可能已经生效，记录为 unknown，需要先检查状态。
- 对话栏右上角的“清空上下文”会停止当前任务，清除本段消息、待发送要求和 REPL 临时状态，保留当前工作区文件、脚本绑定及模型设置。清空结果会持久化，后续模型请求不会携带旧对话；“新会话”则创建独立工作区。任务与工具记录保留用于检查操作结果，不会重新变成聊天消息。
- REPL 支持 await、显式 return 和 `state`。局部声明不跨调用保留；停止、超时或 Worker 异常重置内存状态。计算限制为 64 MiB，默认 15 秒，最多 60 秒。
- Agent 每轮最多 30 个模型步骤。运行中补充要求在下一步骤边界注入；模型提前结束时，未消费的要求保留在队列，可手动继续发送。
- 任务记录保存实际模型配置（不含密钥）、逐步结束原因、工具名、token 用量（由模型服务提供时）和终止错误。可恢复的工具参数错误不会把最终完成的整轮标为失败；原始连接错误不会被后续的“无输出”错误覆盖。旧版空消息 ID 会在读取时修复。
- 截图保存为 Blob 工件。启用图片能力后，SDK 将图片作为图像内容发给模型，工具文本和会话记录只保留引用。网络正文按需读取，协议输出有大小限制。
- API key 使用独立 `chrome.storage.local` 配置项，不写入工作区、REPL、模型提示或 Monkey 设置导出。普通网页开发预览使用该预览 origin 的 localStorage。
- 同一扩展中的独立模块不是独立权限主体。首版的 Monkey 外部修改检查是保存前重读，不提供与宿主编辑器之间的原子 CAS。

## 模型工具与 REPL

文件工具参照 [Claude Code SDK 的公开参数](https://code.claude.com/docs/en/agent-sdk/typescript#tool-input-types)和[工具行为](https://code.claude.com/docs/en/tools-reference)：`Read(file_path, offset?, limit?)` 按行读取，`Write(file_path, content)` 全量写入，`Edit(file_path, old_string, new_string, replace_all?)` 精确替换，`Glob(pattern, path?)` 匹配文件，`Grep(pattern, path?, …)` 搜索内容。现有文件先读后改，修订由 harness 自动跟踪；不要求模型传 expectedRevision。内部仍通过事务拒绝并发覆盖。具体差异和上限见 [文件工具指南](src/agent/guides/file-tools.md)。旧 files 调用只保留为历史兼容，不向模型展示。

`repl` 使用 `{code, timeout?, description?}`，其中 timeout 是毫秒；继续执行 QuickJS JavaScript，不提供 Bash 或后台 shell。支持 `await sleep(ms)`，停止时取消。`browser.navigate(url, options)` 在发送导航命令前注册等待，避免先改 location 再等待产生的竞态；页面方法内的 timeoutMs 与整个工具的 timeout 分别控制各自期限。

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

## 内部调试导出

无需增加界面或重新加载扩展：在 `chrome://extensions` 找到 Monkey，开启开发者模式，点击扩展的 **Service Worker / 服务工作线程** 检查入口，在其 Console 粘贴运行 [export-debug-data.js](scripts/export-debug-data.js) 的全部内容。成功后 JSON 已进入剪贴板，粘贴保存为 `monkeyagent-debug.json`。

脚本默认导出最近使用的工作区，并打印工作区 ID 和标题列表。需要指定另一段任务时，将脚本顶部 `workspaceId` 改为表格中的对应 ID 再执行。它只读当前 Agent 数据库，导出该工作区的对话、任务、工具输入输出与错误、文件修订、脚本绑定和文本工件；不读取 Monkey 的其他数据库。模型配置仅导出当前 provider、地址、模型和图片能力，不导出 API Key。常见认证字段、URL 中的认证参数以及意外出现在文本中的当前模型密钥会被遮盖；脚本与网页内容仍需检查后再分享。

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
| monkey.spec.ts          | 四方法宿主适配器、同名冲突、实际 `document-start` 与 GM API、交互、启停                     |
| resilience.spec.ts      | 停止、取消排队工具、超时、不重放、人工草稿冲突、差异恢复、窄屏                              |
| runtime.spec.ts         | 实际 F12 Agent 面板、MV3 CSP/WASM、原生面板切换、停靠模式和关闭清理                         |
| closed-loop.spec.ts     | 实际 F12 Agent 完成编写、Monkey 安装、原生鼠标交互、失败验证和修复                          |
| steering.spec.ts        | 步骤边界接收补充要求、消息持久化、停止模型流与密钥不进入模型请求正文                        |
| sessions.spec.ts        | 多窗口目标与工作区隔离、会话独占、关闭单个窗口及历史会话恢复                                |
| context.spec.ts         | 清空对话并持久化、保留文件与脚本绑定、取消运行和排队要求、后续模型请求排除旧消息              |
| harness.spec.ts         | Claude Code 风格文件工具、错误恢复、精简结果、导航等待、消息 ID、逐步用量与终止错误持久化 |
| debug-export.spec.ts    | 内部控制台导出、工作区隔离、工具失败与修订、密钥和认证字段遮盖、原数据保留                    |

前端组件的开源来源和许可证见 [THIRD_PARTY.md](THIRD_PARTY.md)。构建会生成 `THIRD_PARTY_LICENSES.txt` 并随扩展发布。
