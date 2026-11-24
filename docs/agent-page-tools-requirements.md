# Agent 页面源码、请求工具与上下文减负 需求文档

状态：分期实现。repl.output_file、Grep 字符窗口、/source、http.request、复用 F12 的只读 networks、工具大结果 /artifacts 保存及最小自动上下文压缩已实现；宿主 code/details 已贯通 REPL。browser.evaluate 补缺失的 SyntaxError 位置及非 Error 抛出内容，REPL 编译错误位置与其共用格式，已有文本堆栈原样保留，不附加重复错误字段。其余研究项继续按收益取舍。更新日期：2026-11-24。适用模块：`packages/devtools-agent/`。

证据样本：`case/` 下 2026-11-20 导出的一份探索类 debug pack（某 Web 平台页面上的只读探索任务，5 轮 run、96 步、92 次操作，文本模型，图片输入关闭）。相关文档：[DevTools Agent 设计](devtools-agent-design.md)、[调试轨迹评估](agent-debug-trace-1-review.md)。

证据边界：本轮设计复审时工作区已无 `case/`，下文样本数据沿用原草案，未重新核验原始轨迹。不能据此认定所有探索任务都有相同分布，也不能把技术审查中发现的每个潜在问题都升级为新功能。

隐私说明：本文档已脱敏，不记录站点域名、内部平台/组件名、业务 API 路径、资源哈希名、会话标识或模型配置；仅保留问题模式、聚合指标与本项目源码位置。原始 debug pack 含站点数据，引用与分享前需另行审查。

本文档定义一组工具与运行时改进，目标是减少 agent 为请求、检索和搬运页面数据编写的重复代码。命名工具负责可独立完成的高频动作；REPL 保留为组合、计算和变更操作的编程入口；两者复用宿主能力，不各自实现一套请求、存储或错误处理。既有 mutation/verification 纪律不变。

---

## 1. 背景与问题

### 1.1 样本会话概况

任务：确认页面发出的请求 → 定位某统计面板的数据 API 并测试鉴权 → 只读探索数据来源 → 确认上报组件。agent 全程只读，结论质量高，但工效学问题显著。

| Run | 步数 | 输入 token | 输出 token | 时长 |
| --- | --- | --- | --- | --- |
| 1 | 6 | 39,765 | 2,427 | 25s |
| 2 | 11 | 175,631 | 6,827 | 45s |
| 3 | 29 | 1,075,284 | 17,994 | 131s |
| 4 | 35 | 2,141,194 | 19,341 | 182s |
| 5 | 15 | 1,246,862 | 15,052 | 153s |
| 合计 | 96 | **4,678,736** | 61,641 | 536s（表中 run 时长求和） |

run 时长求和与包含用户停顿的会话跨度不是同一个指标；原草案的约 19 分钟会话跨度需以原始时间戳另行核验。

样本时的最终上下文约 258KB（≈86K token），其中工具结果占 164KB（63%）。当时无上下文压缩机制，历史全量重发，累计输入成本随步数近似平方增长；本轮最小压缩实现见 9.7，尚未据原样本复测收益。

### 1.2 操作分布（90 次 REPL）

| 模式 | 次数（约） | 典型形态 |
| --- | --- | --- |
| 页内 fetch + 结果切片 | 40 | ``const expr = `(async()=>{ const r = await fetch(u,{credentials:'same-origin'}); … })()`; return await browser.evaluate(expr)`` |
| bundle 反复 fetch + 正则/indexOf 扫描 | 15+ | 同一主 bundle（`index-<hash>.js`）被重新 fetch 扫描十余次，每次手写上下文提取代码 |
| 抓包管道 | 8 | connect → Network.enable → bookmark seq → events → filter/map requestWillBeSent/responseReceived |
| DOM 查询 | 6 | tab 列表、表格列名、链接提取 |
| state 数据整理 | 其余 | 对 `state.bodies` 做 JSON 解析与字段筛选 |

92 次操作中 **0 次文件写入**。捕获数据只放 `state`（易失）或直接回显进上下文（膨胀）。

### 1.3 失败根因（4 次失败中 3 次源于同一设计）

| 日志条目 | 错误 | 根因 |
| --- | --- | --- |
| repl[31] | `page_exception: SyntaxError: missing ) after argument list` | `browser.evaluate` 表达式含顶层 await；CDP 按普通程序求值，无 async 上下文。错误信息未提示真实原因 |
| repl[42] | `error: unexpected token in expression: '}'` | 页面代码正则中的 `${}` 被外层 REPL 模板字符串插值 |
| repl[57] | `error: expecting ';'` | 页面代码要搜索含反引号的标识符字面量，反引号提前终止外层模板字符串 |
| repl[73] | `page_exception: TypeError: Cannot read properties of undefined` | agent 假设响应为列表形状并直接取长度，API 实际返回 422 错误体；stack 仅 `<anonymous>:4:79`，无定位价值 |

[31][42][57] 共同根因：**REPL 代码（QuickJS）以模板字符串嵌套页面代码（Chrome）**，页面代码中的反引号与 `${}` 必须双重转义，文档未警告，错误无行号。此后 agent 每次调用都背负 IIFE 包装与转义负担。

### 1.4 根因归纳

1. **files = code 的产品心智**：文件系统被定位为 userscript 源码（site 共享、revision 跟踪、进 system prompt 目录列表）。guides 对数据复用的唯一建议是 "Keep reusable data in state"（`src/agent/guides/debugging-workflow.md:7`），没有"捕获数据落盘 + 按需检索"的模式。
2. **字符串套字符串的求值传输**：高频操作（fetch、扫描）被迫写成嵌套模板字符串。
3. **缺少摘要型 helper**：网络事件只有原始 CDP 形态，请求关联、字段筛选全靠 agent 手写。
4. **上下文只进不出**：128KiB 以下结果全量永久留在历史；截断 preview 仍达 32K 字符。
5. **行式工具与 minified 单行文件不匹配**：Read 截 2000 字符/行（`src/agent/file-tools.ts:43`）、Grep content 截 2000（`:238`）、fs.search 截 500（`src/workspace/service.ts:234`），对单行数百 KB 的 bundle 拿不到匹配点上下文。

---

## 2. 目标与非目标

### 2.1 目标（以样本会话为基准回放度量）

| 指标 | 基线 | 目标 |
| --- | --- | --- |
| 等价任务累计输入 token | 4.68M | ≤ 50% |
| 转义/包装类语法失败 | 3 次 | 0 |
| bundle 检索子任务手写 JS 比例 | 100% | ≤ 20%（其余走 `/source` + Grep/Read） |
| 可由扩展 HTTP 完成的请求子任务手写 IIFE 比例 | 100% | ≤ 20%（使用 http.request；页面身份语义的请求仍走 browser.evaluate） |
| 抓包管道 boilerplate | 每次 ~6 行 | 0（helper 直出摘要） |

### 2.2 非目标

- 不替代 REPL：DOM 交互、组合操作、脚本安装/验证仍走 REPL + 既有纪律。
- 不做完整 prettify/AST 解析：minified 代码用字符窗口 snippet 解决，不引入 beautifier 依赖。
- 不改变 mutation 语义：read-before-write、revision 冲突检测、scripts.apply 安装链路不动。
- 不扩大浏览器作用域：仍限绑定 tab 及其 owned child sessions。
- browser 操作不实现跨 tab 访问。新增 http.request 是显式扩展侧 HTTP 客户端，可在已授予 host 权限下跨源请求，按用户任务授权使用；它不自动复用页面身份或隐式获取任意站点。/source 仍仅包含当前调试目标实际加载的资源。

---

## 3. 痛点取舍与工具分层

### 3.1 选择标准与本轮取舍

新增能力应减少反复出现的代码、降低环境混淆，或让结果能被继续检索。调用频繁能支持封装 helper，但还不足以证明应再增加一个顶层工具。实现约束不自动变成模型可见的新功能。

| 问题 / 原建议 | 取舍 | 理由 |
| --- | --- | --- |
| 请求重复编写 IIFE、转义及页面 CORS | 实现 REPL 内置 http.request，不新增顶层 Fetch/PageFetch | 请求在扩展侧执行；确需页面 origin/状态的请求仍显式通过 browser.evaluate，两个执行环境不自动切换 |
| bundle 反复获取、手写 indexOf | 保留 /source 和 Grep 字符窗口 | 复用已有文件检索心智；窗口检索也适用于普通文件 |
| 抓包事件反复关联、filter/map | REPL 顶层 networks 复用 F12 原生日志，不新增顶层 Requests 工具 | 自动观察；按需查询摘要、原生详情、正文与 HAR |
| SyntaxError 自动包装重试 | 不采纳 | 异常可能发生在已有副作用之后，不能据异常类型重跑代码 |
| REPL 函数遇到大值就改返回文件引用 | 不采纳 | 后续 JSON.parse、map/filter、长度判断和 state 保存会因大小变化而失效 |
| 函数遇到大结果自动写 workspace | 不采纳 | 文件写入由显式代码或最外层 repl.output_file 参数触发，不能根据内部函数结果大小偷偷发生 |
| 256KiB 桥接限制 | 按各公开接口明确预算；源码内部取体单独处理 | 超限应是声明过的错误，不能静默返回半个值或换一种类型 |
| 最终工具输出过大 | 保留显式 repl.output_file；默认 REPL 最终 JSON 超过 8 KiB UTF-8 时统一自动保存 /artifacts，回显 2 KiB 首尾预览与恢复路径 | 只调整工具输出层，函数返回值与 state 保持完整；其他工具沿用原阈值并共用 artifact 保存 |
| 自动镜像全部 state | 本期不做 | 显式文件/工件已能保留需要恢复的数据，不引入任意 JS 堆恢复语义 |
| 旧历史压缩 | 实现可配置阈值与一次当前模型摘要 | 保持原始记录，按完整工具边界替换模型输入，持久化摘要和覆盖边界 |
| 函数源码传输 | 研究项 | 先验证独立收益和兼容性 |

### 3.2 模型直接工具

保持 `Read / Write / Edit / Glob / Grep / repl` 六个公开工具。历史 files 别名继续只用于兼容。暂不新增 PageFetch、PageRead、PageGrep、SearchBundle 或独立请求摘要工具。

| 入口 | 职责 |
| --- | --- |
| Read / Glob / Grep | 读取和检索 /workspace、/docs、文本 /artifacts 以及显式指定的 /source；沿用已声明的阅读范围、检索窗口和分页契约 |
| Write / Edit | 显式编辑源码或数据文件，保留 read-before-write 和原子修订检查 |
| repl | 发起请求、组合数据、检查 DOM、调用协议、安装与验证；程序决定 return 值，工具调用者可用 output_file 显式选择文件输出 |

单次请求也可直接写 `return await http.request("https://api.example.com/data");`，不需要增加同义顶层工具。文件工具已有独立价值：编辑修订跟踪、行式阅读和检索参数，不因这次取舍统一删成 REPL API。

### 3.3 REPL 宿主 API

| API | 设计 |
| --- | --- |
| fs.list/read/write/edit/remove/rename/search | 保留既有契约。fs.read 是 0-based 字符范围，Read 是 1-based 行范围；fs 修改接口继续显式传 revision |
| http.request(url, options?) | 已实现的扩展侧 Promise HTTP 客户端，返回固定响应数据。正文在资源限额内完整返回，不返回 Node ClientRequest/原生 Response，也不按大小变成摘要、路径或 artifact |
| networks.status/list/get/requestBody/responseBody/getHAR | 已实现；复用 F12 原生 HAR 与 getContent，跟随 Clear/Preserve log；摘要分页与正文范围显式约定，不改写 browser.events |
| browser.evaluate(expression, options) | 保留原样求值、await Promise、返回页面值及异常语义，不自动重写或重跑 |
| browser.responseBody(requestId, sessionId?) | 保留小响应的原有形状和限额；超限明确失败，不自动改成引用，也不重新发请求 |
| browser.send(method, params, sessionId?) | 保留原生 CDP 参数和返回字段；通用协议保护不转化为截断后仍冒充完整的协议对象 |
| contexts / navigate / reload / screenshot / waitForEvent / connect / disconnect | 保留现有职责；screenshot 返回工件是它原本明示的接口，不作为其他函数偷偷换返回值的先例 |
| scripts.* 与 browser.verify | 保留安装、状态与验证语义，执行成功与断言/任务满足分开 |

不增加 fs.snippets、fs.grep、browser.fetchJson 或 browser.scanBundle 等同义入口。需要扩大检索窗口时，由 Grep 返回 window_start，调用现有 fs.read。

### 3.4 执行值、模型输出与显式写入

这是本轮设计的硬边界：

| 层 | 行为 |
| --- | --- |
| 函数执行 / QuickJS 内部值 | 完整结果供当前程序继续计算、catch 或保存在 state；大小不同不改变函数返回类型 |
| 整段 repl 完成后的模型输出 | 未传 output_file 时，最终 JSON 在 8 KiB UTF-8 内直接返回，超出后保存 /artifacts 并给 2 KiB 预览、完整引用与读取提示；显式 output_file 仍返回指定文件元数据。均不回写内部变量 |
| 显式 fs.write / Write / Edit | 按调用参数实际写文件，按原 revision/大小限制成功或失败；不自动换目录、换存储类型或放弃保存 |
| 显式 repl.output_file | 程序完成后由宿主保存一次最终结果；不保存整个 state 或每次宿主函数的中间返回值 |
| 运行记录 / 输出工件 | 超大最终结果统一保存为 /artifacts 的完整 JSON，运行记录保留有限预览和引用；不增加一次执行或覆盖用户文件 |

例如代码先取得响应、JSON.parse、筛选再 return 计数时，即使原始响应很大，计数也应准确；模型可选择直接收到计数，或用 output_file 保存同一个计数。是否保存由参数决定，不由返回值大小决定。网络/宿主输入限额仍有效，超过它们返回可识别错误，不把资源保护解释为必须支持无限数据。

错误 code/details 必须穿过宿主、Worker、QuickJS、ReplClient 完整保留。新增 API 同时更新 schema、运行时注册、宿主分派、工具描述和 guides。输出处理不递归进入串行队列、不启动后台执行、不重放请求或代码。

### 3.5 需求与阶段

| 编号 | 需求 | 阶段 | 依赖 / 约束 |
| --- | --- | --- | --- |
| R1 | /source 只读源码虚拟挂载 | 1（已实现） | DevTools/CDP 按需取源，不依赖请求 helper |
| R1.2 | Grep 字符窗口 | 1（已实现） | 扩展既有 Grep 工具；不新增工具或 REPL API |
| R2 | http.request 扩展侧客户端 | 1（已实现） | 固定返回值、权限/凭据/资源/timeout/cancel 契约；不新增 Fetch 工具或 browser.fetch |
| R3.1 | evaluate 保持语义 | 1 | 不自动包装重试 |
| R3.2 | 错误 hint 与位置 | 1 | 保留异常类别及完整传播 |
| R3.3 | guides 与工具契约说明 | 随所属能力 | 发布前声明限额与结果表示，不提前推荐未实现接口 |
| R4 | 复用 F12 Network 的 networks | 2（只读接口已实现） | 自动观察、摘要/详情/正文/HAR；原事件和 CDP 配置保持 |
| R5.1/5.2 | repl.output_file 显式结果保存与按需读取 | 1（已实现） | 只处理最终 return 的序列化结果；默认行为与内部函数语义保持 |
| R6.1 | REPL 语法位置完善 | 2（已实现） | 与 browser 共用 1-based/UTF-16 位置格式，保持错误来源与既有 code |
| R5.3 | 历史压缩 | 3（最小实现已接入） | 模型设置阈值、单次交接摘要、完整工具边界和持久化；不重放工具 |
| R3.4 / R6.2 | 函数源码传输 / 历史大响应扩展 | 研究项 | 分别验证独立收益 |
| R6.3 | state 宿主镜像 | 本期不做 | 保留易失语义，数据显式保存 |

---

## 4. R1：`/source` 页面源码虚拟挂载

实现状态：已接入 WorkspaceService、Glob/Grep/Read/fs.list/fs.read。按需启用 Debugger，已编译 JS 使用 Debugger；其余资源优先无 frame 歧义的 DevTools Resource.getContent，否则使用 CDP Page。路径实际带稳定代次/身份后缀，不应按下方示意手工拼接。已实现 8 MiB 单资源、32 MiB 缓存、5 分钟 TTL，Grep 8 MiB 源码扫描预算及 skipped 报告；缓存不自动落库或导出。fs.search 仍搜索持久化文件，对 /source 明确提示使用 Grep。Network 捕获体补充和 sourcemap 原始文件尚未实现。API 覆盖以浏览器实际提供的来源为准。

### 4.1 用户故事与命名

用户所说的来源是 F12 **Sources** 中的页面源码，而不是把资源 URL 重新 fetch 一遍。模型应能直接：

```js
Glob({pattern: "**/*.js", path: "/source"})
Grep({pattern: "api/v1", path: "/source", output_mode: "content", char_context: 200})
// 路径以 Glob/Grep 返回的实际路径为准。
Read({file_path: "/source/main/https/example.com/assets/main.js", offset: 1, limit: 5})
```

`/source` 是只读虚拟根，统一使用该名称，不另设同义挂载。源码正文按需读取、在宿主缓存，不默认写入工作区，也不灌进 system prompt。

### 4.2 可用 API 与获取顺序

| 来源 | API | 用途与边界 |
| --- | --- | --- |
| DevTools 页面资源 | `chrome.devtools.inspectedWindow.getResources()`、`Resource.getContent()` | 真实 F12 环境中的资源清单和内容入口，覆盖文档、脚本、样式等；只把可用文本映射成源码文件。当前最低 Chrome 135，采用 callback 形式或内部 Promise 适配，不依赖 Chrome 151 才加入的 Promise 重载。 |
| CDP 页面资源 | `Page.getResourceTree`、`Page.getResourceContent({frameId,url})` | 资源树与内容的另一条后端路径；用于能力验证、缺失资源及不具备 DevTools API 的 fixture，按浏览器支持情况处理。 |
| 运行时脚本 | `Debugger.enable`、`Debugger.scriptParsed`、`Debugger.getScriptSource({scriptId})` | 读取已编译脚本，包括 inline、eval、带 sourceURL 的脚本。启用 Debugger 时会报告已知且未被回收的脚本；不要求都在开启网络捕获后才加载。 |
| HTTP 捕获体 | `Network.getResponseBody` | 仅作具有匹配响应证据的资源补充来源，不作为源码索引的基础，更不意味着所有历史请求体都可恢复。 |

Provider 在宿主封装来源差异。通过 DevTools/CDP 资源树建立索引；已编译 JS 优先 Debugger.getScriptSource，避免通用资源加载器顺带补体。其余资源优先无 frame 歧义的 DevTools API，然后 CDP Page。Debugger 按需启用，补齐动态来源。仅在需要的来源上读取正文。CDP 路径继续使用现有 BrowserSession，不能附加到其他标签页。验收发现 Chromium 通用资源后端可能补载缺失的资源体；实现不调用额外 fetch，但不能宣传所有 HTML/CSS 取源都保证离线或不产生浏览器内部请求。

`performance.getEntriesByType('resource')` 最多作为发现 URL 的补充线索，不作为“所有 Sources 源文件”的权威清单。默认不通过 fetch 回退：源码不可用时如实说明，模型可以显式调用 http.request 请求绝对 URL，但那是具有扩展侧凭据语义的新请求，不等同于读取执行中的源码。

这些 API 支持的是源码来源，并不等于公开了 Sources 面板的整个 UI 工作区。资源被释放、后端不支持、动态脚本已回收时，允许返回 `resource_not_available`，不能伪造完整覆盖。

### 4.3 初始覆盖与 sourcemap 边界

- 首批覆盖当前页面及已有 owned frame/Worker 会话中可读的 HTML、CSS、JS 和运行时脚本。child target 的发现仍由 BrowserSession 管理；没有相应来源能力时报告覆盖范围，不假装完整。
- 当前页面实际加载的 CDN 脚本属于当前调试目标；若 DevTools/CDP 已持有源码，可映射读取，不因 URL 跨 origin 而要求页内 CORS fetch。不能据此任意抓取外部站点文件。
- HTML 资源内容与实时 DOM 不是同一种证据。Read 源 HTML 不等于读取当前 DOM，动态 DOM 仍由 evaluate 检查。
- **sourcemap 还原源码单独设计**：TS、Vue、webpack 原始路径可能是 DevTools 前端根据映射构造出的视图，不能承诺 getResources/getScriptSource 直接返回所有原文件。首批保留 `sourceMapURL` 元数据，不主动下载映射。后续若支持，只把确实恢复到的原文件放到独立命名空间，并保留与生成代码的关联。
- pretty-print 是展示变换；首批按实际原文检索并使用字符窗口，不把格式化后的行号冒充运行时代码位置。
- Fetch/XHR 响应不混作 Sources 源文件；由请求工具或捕获接口保存为 `/workspace/scratch` / `/artifacts` 后同样可 Read/Grep。图片、字体、媒体、Wasm 不伪装为 JS 文本。

### 4.4 路径、身份与返回元数据

示意树：

```text
/source/main/https/example.com/index.html
/source/main/https/example.com/assets/main.js
/source/main/https/cdn.example.com/vendor.js
/source/main/inline/<script-key>.js
/source/main/eval/<script-key>.js
/source/<owned-target-key>/...
```

- 网络资源身份包含完整 URL（含 query）、frame/target 和导航代际；运行时脚本身份包含 session/target、scriptId 和代际。不能只用 pathname 去重。
- 相同展示路径但不同身份时，加稳定短后缀，保留扩展名以便 Glob。query 差异不能“后见覆盖”；相同 URL 的不同 inline/eval 脚本也不能丢失。
- `/source` 下路径只由索引给出，模型无需拼 scriptId、frameId 或查询哈希。列表携带 `sourceUrl?`、`kind`、`provider`、`frameId?/sessionId?/scriptId?` 和可用性；正文结果保留原始来源。
- `revision` 绑定实际文本快照或来源版本，不使用所有文件共用的常量 `source-v1`。运行时编辑或重新读取导致内容变化时修订改变；Grep 返回的窗口和后续范围读取需要可核对同一 revision。
- `workspace.list('/source')` 返回资源元数据，不返回正文；未知大小明确标记，网络传输字节数不冒充解码文本长度。
- 默认 `workspace.list('/')` 与 system prompt 不列出所有源码条目；guides 说明挂载存在，模型显式 Glob/list 才展开。

### 4.5 正文、缓存与预算

1. 命中当前来源快照缓存时直接读。
2. 按记录的 provider 读取资源内容或运行时脚本；捕获体只用于确实关联到该资源的情况。
3. 失败则返回带来源和原因的错误；不静默换成一次新请求，也不自动重试页面代码。

宿主取体与模型输出限额是两件事。源码内部读取不能先经过通用 send 的 256KiB 结果检查而被挡住，也不必先搬入 QuickJS；但 `browser.send` 的公开原始协议契约与保护仍保留。上述标准取源接口通常整段返回，不把“宿主取体后范围读取”宣传成协议流式读取。

- `fs.read` 保持 0-based UTF-16 字符范围，返回 `offset/totalLength/truncated`；Read 保持行范围。成功保留完整文本后，`totalLength` 才能声明精确。
- 初始候选预算：单份源码 8MiB、宿主缓存总量 32MiB、TTL 5 分钟；用 fixture 与真实资源规模校准。超限明确 `resource_too_large` / skipped，不能以截断前缀伪装全文。
- 缓存同时受总量和 TTL 限制；运行时脚本失效、主 frame 导航、reload、目标切换、断开导致来源失效时清理相应条目。
- 异步取体绑定导航代际；旧页面的迟到结果不得写进新页面缓存。失效后返回 context_changed，让调用者重新列举。
- Grep 单次累计扫描预算初值 8MiB，同时检查取消和总时限；跳过的文件返回原因。缓存命中不代表没有解码/扫描成本，负面结论必须考虑 skipped。

### 4.6 集成与验收

- `normalizePath` 增加 source 根；WorkspaceService 注入 SourceProvider；`writable` 明确拒绝该根。文件工具复用 provider，不增加 PageRead/PageGrep 或单独的 REPL source API。
- Debugger 的 scriptParsed 注册表不能仅依赖会被淘汰的通用事件缓冲。来源索引只保留必要元数据，并随页面生命周期失效。
- 对资源加载早于 Agent 连接的 fixture：仍能列出并通过 Debugger 读取可用脚本，JS 请求不被额外重发；HTML/CSS 的浏览器后端补体边界见 4.2。
- 外部 bundle、inline、eval、懒加载、当前页面加载的 CDN 脚本、同 URL 不同 query 的来源均有明确且不混淆的路径。
- 500KB minified 源码可以直接 Grep 字符窗口，再经 fs.read 扩大，不写 fetch/indexOf 搬运代码。
- 导航、来源内容变更、读取中切换页面、资源不可用、预算超限均有覆盖；不能把浏览器未提供的内容算作“无匹配”。
- Write/Edit/fs.write 对 /source 都返回 read_only；system prompt 和 debug pack 不自动包含其正文。导出 limitations 说明源码是易失虚拟来源。

---

## 5. R1.2：Grep 字符窗口

实现状态：现有 Grep 已支持 char_context，覆盖工作区、完整文本工件及 /source。

`char_context?: number`（0–2000）可用于所有文本路径，不只 /source。只有 `output_mode:'content'` 才能传入；与 -o、-A/-B/-C/context 同传返回 invalid_input，不静默忽略。

每个匹配返回：

```jsonc
{
  "file_path": "/source/...",
  "revision": "当前文本快照",
  "offset": 10240,         // 匹配起点，0-based UTF-16 字符索引
  "window_start": 10040,   // text 对应的起点，可直接用于 fs.read
  "match_length": 8,
  "text": "匹配点前后最多 char_context 个字符",
  "is_match": true,
  "truncated": false
}
```

- 同一行多个匹配分别返回。char_window 的 total_matches 计匹配次数；原行模式的计数语义不变。支持零长度匹配但必须保证扫描前进。
- 输入 offset 仍是结果分页偏移；entry.offset 是原文字符位置，不能混淆。返回 `output_mode_detail:'char_window'`。
- 单条 text 最多 4000 个 UTF-16 字符，单次结果受 16KiB 序列化 UTF-8 预算约束（为结果和工具元数据预留空间），实际条数还受 head_limit 约束。单条含转义字符的窗口也会按字节预算收缩，并保留匹配位置；元数据本身过长无法放入单页时返回 size_limit。
- 超长匹配按预算缩短，保留 match_length 和定位信息，以 entry.truncated 标记。顶层 truncated 仅表示还有后续匹配条目，分页返回 next_offset，truncation_reason 为 head_limit 或 output_budget。两种截断含义不混淆。
- /source 搜索返回 search_complete、scanned_bytes、skipped_count 和受预算限制的 skipped 原因样本；总匹配只统计已扫描内容。取消或上下文失效时返回错误。不能用“输出已分页”掩盖漏扫。普通工作区搜索保留既有行为。
- 验收覆盖：单行 500KB 的三个匹配、emoji 索引、零长度正则、超长匹配、多页恢复、无匹配与超预算的区别、取消。既有 Read 行截断提示补充指向字符窗口。

---

## 6. R2：REPL 内置 http.request

### 6.1 显式扩展侧 HTTP 客户端

已按最新讨论改为扩展侧 HTTP 客户端，通过已授予 host 权限发起原生 fetch；不在页面中求值，也不要求调试器连接。REPL 内置 frozen http 模块，只提供 Promise 风格 request；不引入 require/npm/通用包加载，不承诺兼容 Node node:http 的 ClientRequest、回调、流或 socket。成功返回固定数据，失败抛错，已有 browser.evaluate/browser.send/fs 契约保持。browser.fetch 未实现，也不增加同义顶层工具。

```js
const response = await http.request("https://api.example.com/data", {
  method: "GET",
  credentials: "omit",
  timeoutMs: 15000
});
state.response = response;
return {status: response.status, bodyChars: response.body.length};
```

签名为 http.request(url, options?)，options 为 strict object：method?、credentials?、redirect?、headers?、body?、timeoutMs?。多余参数、未知字段和类型错误在发送前拒绝。不接受 saveTo/maxPreviewChars，不在请求函数中混入持久化或模型输出控制。完整契约见 packages/devtools-agent/src/agent/guides/http-api.md。

- url 必须是绝对 HTTP(S)，最多 8192 UTF-16 单位，不允许内嵌账号密码。相对 URL 拒绝，不继承页面 base/origin/localStorage。扩展宿主使用已授予的 host 权限，普通网页预览仍受其运行环境的跨域限制。
- method 默认 GET，支持 GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS；GET/HEAD 带任何 body 在发请求前拒绝。业务授权不能只由 HTTP 方法判断。
- credentials 默认 omit，可显式 include；浏览器 Cookie/SameSite/分区策略与服务端鉴权仍生效，不保证等于页面登录态。headers 为字符串映射；Cookie/Origin/Referer/Host/Content-Length/User-Agent/Sec-*/Proxy-* 等浏览器控制或不支持的头明确拒绝。body 只接受 UTF-8 字符串，不隐式转 JSON/form。
- redirect 默认 follow，可 error，原生重定向行为与自动重试分开。
- timeoutMs 默认 15000、最大 60000，同时受外层 repl 总 deadline 约束，不能延长已到期的程序。
- 这是项目 helper，不是浏览器原生 Response；公开说明它返回可序列化数据，不能调用 response.json()/text()。

### 6.2 固定返回值与错误

```jsonc
{
  "status": 200, "statusText": "OK", "ok": true,
  "url": "最终 URL", "redirected": false,
  "headers": {"content-type": "application/json"},
  "body": "{\"rows\":[]}",
  "base64Encoded": false, "bodyBytes": 11
}
```

- body 始终是完整字符串。text/*、JSON/+json、XML/+xml、JavaScript、form-urlencoded 和 SVG 按 UTF-8 解码，符合 Fetch Response.text 行为；二进制、缺失或未知 MIME 用 base64 并标明 base64Encoded:true。HEAD/空响应为 body:""、bodyBytes:0、base64Encoded:false；bodyBytes 是从 Fetch 解码流读取的实际字节数，不采用压缩传输 Content-Length 冒充正文长度。
- HTTP 401/422/500 正常返回，ok:false；网络/权限/超时/取消才抛宿主错误，code/details 能在 REPL catch 与外层读取。HTTP 读取阶段错误携带 environment:http/url/method。
- 请求 body 限 2 MiB UTF-8；响应限 2 MiB 解码字节及 3 MiB 整体序列化 JSON（转义较多时可能先触发）；超限 response_too_large，不返回部分正文。上限与 QuickJS 64 MiB 内存、浏览器/宿主复制成本分别说明。
- 同一 Controller 最多四个在途请求，额外调用发送前返回 http_busy，不隐式排队或重试。
- 限额校准：4MiB 的异步 JSON 返回在最小 QuickJS 用例中也会于释放时触发运行时断言；当前采用并测试 2MiB 正文/3MiB 桥接，包括上限文本、base64 二进制及接近桥接限额的转义文本。未来扩大额度需要重新验证运行时分配和释放。
- helper 的宿主传输可与通用 browser.send 的 256KiB 限额区分实现，但限额必须在各接口说明中给出，不能公开任意跳过保护开关。
- 不根据响应大小自动创建 workspace 文件、artifact 或摘要；也不因输出预算降低就提早中断响应。

需要保存时显式编写：

```js
const response = await http.request("https://api.example.com/data");
if (!response.ok) return {status: response.status, body: response.body};
const saved = await fs.write("/workspace/scratch/result.json", response.body);
return {status: response.status, saved};
```

fs.write 沿用原有路径、revision 与内容大小约束；冲突或超限如实失败。不能偷偷改为 artifact 后宣称写入了指定路径。若显式落盘失败，不能自动重跑先前请求；REPL 已执行的动作不会回滚。

### 6.3 取消与验收

使用扩展宿主 AbortController，将本次 REPL 生命周期与请求 timeout 合并；覆盖正文读取、用户停止、外层 REPL deadline、调用结束/异常和 session/Controller 释放。普通同站页面导航不使扩展侧 HTTP 失效；跨站/会话切换触发 stop 时取消。超限终止继续读取。已经完成的服务器行为不能撤销，不自动重放。真实浏览器验收覆盖页面 CORS 拒绝而扩展请求可读、凭据显式选择、大小与取消，并检查请求计数。

验收重点是可组合性：同一结构的小/大响应都能在 REPL 中解析和运算；state 保存完整数据；HTTP 错误能被普通 JS 判断；宿主错误可 catch；网络输入限额与最终模型输出限额分别触发。返回计数与 return 整个 response 应得到同一次计算的结果，后者只在外层展示时可能截断。

---

## 7. R3：evaluate 与错误诊断

### 7.1 保持求值语义，不自动重试

保留 browser.evaluate(expression, {contextId?,sessionId?}) 的现有行为：原样求值、await 返回的 Promise、返回页面值、页面异常抛错。REPL 自身支持顶层 await，不等于传给页面的程序自动获得 async 上下文。

例如 `(++counter, JSON.parse("{"))` 会先产生副作用再抛 SyntaxError；若据异常类型包装并重试，会执行两次。故不采纳自动重试。扩展侧 HTTP 使用明示的 http.request；自定义异步页面程序仍显式使用 IIFE，文档给出小而可运行的示例和模板字符串转义说明。

后续若探索显式 async 选项或 Runtime.evaluate.replMode，须单独验证语句完成值、作用域和 let 重声明等行为，不作为本期默认修改。

### 7.2 错误的环境、位置与传播

实现状态：宿主 code/details 已贯通 host-result、QuickJS Error、Worker result、ReplClient 和外层 ToolResult。经真实浏览器核验，普通 Error/ReferenceError/TypeError/异步 Error 的 description 已有类型、文字和文本堆栈，直接保留。browser.evaluate 没有现成位置/堆栈的 SyntaxError 追加一次可靠位置；非 Error 抛出值保留字面值或浏览器提供的有界对象预览。REPL 编译错误也已读取 QuickJS cause 中的真实位置并还原用户坐标，使用同一格式化函数；原 code/name 语义不变。

- 错误保留 code/message；已有 message 中的类型、说明和堆栈不再重复放入 description/stack/details/excerpt，也不重复拼入同一 message。本轮不添加新的页面错误 details 或 UI 堆栈展示。
- 对外展示的行列单位统一说明；若展示为 1-based，需转换 CDP 的 0-based 行列。位置来自后端时标明来源，不凭字符串猜测精确位置。
- SyntaxError 已有文本位置/堆栈时不再追加。页面位置取可靠 CDP 字段；QuickJS 编译错误单独映射其包装偏移，不改写页面位置。
- hint 只用于已知错误场景，提供下一步动作；不能给所有 SyntaxError 都断言“顶层 await 出错”。
- details 需要穿过 errorData、host-result、QuickJS Error、worker result、ReplClient 以及外层 ToolResult；REPL 中 catch 后应能检查 error.code/details。
- 非 Error 对象仅使用现有 CDP preview，不触发 getter、不额外读取远程属性、不重跑代码；预览最多五个属性，新增消息最多 2000 UTF-16 字符，遗漏内容标记省略/截断。已有普通 Error 文本不重建。

### 7.3 guides 与函数源码传输

guides 随功能交付：工具选择表、三个执行环境、源码与实时 DOM、请求结果与工具失败、预览恢复和 scratch 使用。Read 的源码长行提示指向 Grep 字符窗口；networks 的原生日志与正文范围契约随本期交付。

docs revision 随文档变化更新，但不宣称历史对话内容被重写；旧工具部分继续按已有兼容机制读取。

browser.evaluate(fn,args) 仅保留研究项。除验证 QuickJS Function.prototype.toString 是否有完整源码，还要解决当前 JSON 宿主桥如何在 QuickJS 内先提取源码、闭包不捕获、native/bound 函数拒绝及显式 args。未证明相较现有 helper 的独立收益时不增加入口。

---

## 8. R4：复用 F12 Network 的 networks

### 8.1 直接使用原生日志

根据最新讨论，替换原 browser.requests 关联器提案。Controller 在 DevTools 文档创建时仅订阅 chrome.devtools.network.onRequestFinished/onNavigated，首次查询（包含 status）才读取当前 getHAR 并建立索引；事件通知不触发元数据/正文读取。首次查询前 F12 仍保留的原生日志可读，不需要 networks.start、不预先 attach 或修改任何 Network 设置。browser.events、browser.responseBody 与 browser.send 的既有 CDP 契约保留。

```js
const page = await networks.list({urlFilter:'/api/',types:['xhr','fetch'],limit:50});
// {requests,total,offset,nextOffset,hasMore,revision,observedAt,provider:'devtools'}
const row = page.requests[0];
return {detail:await networks.get(row.id),request:await networks.requestBody(row.id),response:await networks.responseBody(row.id)};
```

摘要包含 opaque id、method/url/type、status/mimeType、startedAt/durationMs、可用的 transferBytes/error；get 返回原生 HAR entry，保留头、cookie、query、postData、timing、initiator 等字段。getHAR 返回原生 log，不额外包 log，也不自动取全部正文。requestBody 返回原生 postData 或 null；null 不代表证明请求无正文，不重建上传文件内容。

- 每次查询刷新原生 HAR，F12 Clear 无通知也能同步；导航和 Preserve log 完全由 F12 决定。不额外积累一份页面历史，不把 UI 显示筛选当成 API 保证。
- HAR 未提供公开稳定 requestId。使用元数据版本 ID，同 URL 请求不合并；完全相同条目按出现次数区分，该组数量变化时全部失效，避免旧 ID 移到邻居上。运行中元数据更新、删除或清空后 context_changed 要重新 list；ID 不得传给 CDP。
- offset/limit 按筛选后的原生顺序分页，limit 默认 50、最大 200，摘要页限 16 KiB；nextOffset 按实际返回数推进。revision 变化时如需一致枚举应重来。完整 URL 在 get 中保留，摘要超过 2000 字符明示 urlTruncated。
- status 明示 available/provider/自动观察，录制状态只报告 managed-by-devtools；API 没有暴露录制按钮状态。完成事件计数不是当前记录数量，不能由空日志推断页面没请求。
- 无公开可靠的 finished 标记，不根据 status 0/time 0 伪造完成状态。响应体通过对应原生 Request.getContent 按需读取；不可用、未结束或已淘汰时如实失败，不 fetch/replay。

### 8.2 限额、控制边界与验收

本期不调整 CDP Network.enable 缓冲，也不增加 start/stop/clear、拦截或重放控制。公共扩展 API 未暴露这些能力及 WS/SSE 消息流；它们需要另外设计，不能声称整个 F12 UI 都已映射。现有 browser.send 仍可显式使用原生协议。

原生元数据快照限 10000 条/32 MiB JSON；get/requestBody/getHAR/正文桥接限 3 MiB JSON。完整编码正文限 2 MiB UTF-8，可显式 offset/limit 读取 UTF-16 字符范围（base64 以编码字符计数）；宿主单次取体仍限 8 MiB，缓存总 32 MiB、TTL 五分钟、LRU 淘汰。原生回调 15 秒超时，停止只取消调用者等待，不取消页面请求。不因大小改变返回类型或隐式保存文件。完整契约见 packages/devtools-agent/src/agent/guides/networks-api.md。

验收覆盖原生 Clear、原生保留日志、同 URL/同元数据条目、分页推进、失效 ID、正文编码/范围/限额/超时/取消及不重放。真实 F12 验证面板显示前请求可读、与 getHAR 对齐、无 chrome.debugger 连接及服务端请求计数不增加；Chromium 136 与当前版本分别验证。

---

## 9. R5：repl 显式文件输出

实现状态：output_file 参数、文件保存、执行/输出阶段错误详情、结果卡片文件链接及使用指南已接入；Grep 字符窗口、/source、http.request 与复用 F12 的只读 networks 也已完成。

### 9.1 参考 Codex 的分层，而非套用所有默认行为

已核对的公开依据：

- Codex 的 ToolOutput 接口区分 code_mode_result 与 to_response_item；MCP 路径可将原始结果交给代码，同时对模型历史中的内容应用输出预算。
- exec_command 的 schema 明确提供 max_output_tokens，响应声明 output 可能截断并包含原始长度等元数据。部分执行工具本身也会遵守自己的显式输出参数；不能概括成“Codex 的一切代码调用都无限量拿到全文”。
- 官方 hooks 文档明确描述 oversized additionalContext 的 spilling：保存完整输出、向模型提供首尾预览和路径；文件保存失败仍给截断预览。这是该输出通道的行为，不能推断所有 Codex 工具都自动保存完整结果。

本项目借鉴的是**执行与展示分离、接口事先声明**。根据最新授权，保留显式 output_file，同时将超大最终工具结果统一保存为 /artifacts；REPL 默认阈值下调为 8 KiB UTF-8，回显 2 KiB 首尾预览与完整引用。内部函数仍直接返回完整值，不根据中间值大小自动落盘或换类型。

### 9.2 repl 工具的显式 output_file 参数

在现有 code、timeout、description 之外，增加一个可选参数：

```js
// 这是模型对 repl 工具的调用，不是在 REPL 代码中调用另一个 repl 函数。
repl({
  code: "const values = [1, 2, 3]; state.values = values; return values;",
  output_file: "/workspace/scratch/result.json"
})
```

| 调用方式 | 行为 |
| --- | --- |
| 未传 output_file | 最终 JSON 在 8 KiB UTF-8 内直接返回，超出后自动保存完整 /artifacts 结果，工具回显 2 KiB 首尾预览、完整引用和 truncated:true |
| 传入 output_file | 程序照常执行一次；宿主保存最终 return 值的序列化结果，工具仅返回文件元数据，不回显全文 |
| 在代码中使用 fs.write | 照常执行，代码可 await/catch 并决定返回什么；与 output_file 不相互替代、不自动互相转换 |

output_file 是可选的绝对虚拟文件路径，只允许 /workspace 下可写位置；不能写 /source、/docs 或 /artifacts，也不是用户操作系统上的任意本地路径。复用路径规范化及既有工作区存储。

是否写文件完全由参数决定：即使结果只有一个数字，指定该参数也保存；即使结果很大，未指定也沿用原有返回方式。调用者在看到结果前就能知道输出模式，不依赖大小触发另一种接口。

### 9.3 文件内容与模型返回

- 文件保存 **最终 return 值的 JSON 序列化结果**，使用与现有 REPL 兼容的 JSON 规则；不是原始代码、ToolResult 外层、所有中间变量或整个 state。
- 数组/对象保存成 JSON；字符串保存为 JSON 字符串，包含引号和转义，不根据后缀猜格式。需要原样文本时显式 fs.write(path,text)，而不是再增加自动格式推断。
- undefined 沿用现有空返回归一化，保存为 JSON null，并保留 undefined_return warning；嵌套 undefined 的既有 warnings 规则不变。循环引用等现有序列化失败仍失败，不能悄悄改写值。
- 文件模式拿到完整的已序列化原始结果，必须早于通用模型输出截断执行；不能把 preview/artifact 元数据当成原 return 值保存。
- 成功只返回文件摘要，沿用已有 fileSummary 字段。size 的单位是该接口既有的字符数，不冒充 UTF-8 字节数。

上例的文件内容为 `[1,2,3]`，模型侧 ToolResult 示意：

```jsonc
{
  "success": true,
  "value": {
    "path": "/workspace/scratch/result.json",
    "revision": "...",
    "size": 7,
    "updatedAt": 1795120000000
  },
  "durationMs": 12
}
```

warnings 按实际情况保留。state.values 在本次成功运行后的内容仍为原数组；保存和返回摘要不会把它改成文件引用。文件模式不额外展示正文预览或展开正文中的图片引用；模型需要内容时用已有 Read/Grep/fs.read 显式查看。

### 9.4 执行、冲突与失败边界

```text
校验 output_file 路径并检查已知冲突
  → REPL 正常执行一次
  → browser/fs 等函数照常返回，程序自行计算、catch、更新 state
  → 显式 return，按既有规则序列化
  → 未传参数：沿用原有工具返回
  → 传入参数：原子创建指定文件，返回文件元数据
```

- output_file 是 create-only。已有路径在可知时于执行代码前返回 conflict；最终写入仍做原子检查，防止运行期间出现同名文件。不自动覆盖、加序号、换目录，也不隐式使用 Read 观察过的 revision。
- 保存沿用 WorkspaceService.write 的内容额度；当前代码实际按 UTF-16 content.length 检查。输出文件过大返回 size_limit，不自动改存 artifact 后宣称已写入指定文件。不借此扩大所有工作区文件的额度；如需专门的大输出存储，另行评估。
- 程序运行失败则不创建输出文件、不保存部分 return；先前已执行的宿主操作仍遵守原有不回滚语义。已有同名文件始终不受失败保存影响。
- **程序完成、输出写入失败**与执行失败明确区分。错误保留原 code，details 说明 phase:output、replCompleted:true 与目标路径，让模型知道代码已经跑过；不得自动重跑来补写输出。
- 输出文件写入发生在程序 return 之后，不能被程序内的 try/catch 捕获。需要在 JS 内控制存储错误时，使用原有 fs.write 并 catch。
- 输出阶段失败本身不得重置成功执行后仍存活的 state；现有停止、超时、Worker 失败及序列化错误语义不由此改变。
- output_file 不绕过浏览器取数限额、QuickJS 内存、序列化保护或 repl 总时限。一个本来取得失败的 browser.evaluate 结果，不能靠这个参数变成可保存的完整值。
- 文件输出在原工具的串行执行范围内完成，不另起后台任务，不递归调用同一工具队列；停止与导航后的不确定状态继续如实报告。
- 参数必须进入 strict schema、工具说明、模型导出的工具定义、UI 结果与 guides；发布前就说明文件格式、create-only、额度和“执行已完成但保存失败”的区别。

### 9.5 数据流、验收与其他输出策略

数据流保持简单：

1. 已加载源码 → /source → Glob/Grep → Read/fs.read。
2. 请求与计算 → REPL 函数直接返回完整值 → 程序自己选择 return 什么。
3. 需要减少上下文 → 在 repl 工具调用中显式传 output_file → 收到文件元数据 → 按需检索文件。

scratch 目录可由显式代码写入，或由显式 output_file 保存到其下；不按内部函数结果大小自动生成。既有共享工作区、文件冲突和 revision 语义保持。

验收必须覆盖：

- 相同代码传/不传 output_file，函数取值、计算、catch、state 更新和执行次数一致；差异限于显式指定的文件创建和工具输出方式。
- 数组、对象、字符串、null、undefined 的文件格式确定；读取并解析得到按现有规则序列化的同一结果，warnings 保留。
- 指定参数时，小结果也保存；保存成功只返回元数据，全文不进入模型上下文。无参数时不引入新的保存副作用。
- 非法路径与已知冲突在执行前拒绝，代码执行次数为 0；执行中出现的重名竞争在输出阶段拒绝，程序仅执行 1 次，state 与目标原文件保留。
- 保存超限或配额失败不改存其他路径，不报告不存在的成功文件；错误能区分 repl 未执行、执行失败及执行完成后保存失败。
- REPL 代码内函数不拿到 preview/path 代替原返回值；output_file 与显式 fs.write 的失败处理差异有可运行示例。
- 工具 schema、模型结果、正常文件读取、UI 与 debug pack 一致；大结果输入限额和文件额度分别验证。

Read/Grep/Glob 仍按各自明确的范围、分页与输出预算工作。超大最终结果的统一保存位于最外层工具输出阶段，不改写内部 fs 函数值；不新增 max_output_chars 参数，也不改写旧历史。

### 9.6 统一的自动 artifact 输出

已实现：REPL 最终 JSON 超过 8192 个 UTF-8 字节时自动保存全文，其他工具保留原有 131072 个 UTF-16 字符阈值并复用同一保存逻辑。统一返回 value.preview、value.artifact（含 path/mimeType/size/id）、恢复 notice、artifacts 引用和 truncated:true。首尾预览含省略标记共不超过 2048 个 UTF-8 字节，不拆 Unicode 字符；预览不是可完整解析的 JSON。artifact 保存的仍是最终 return JSON，不是整个 ToolResult、state 或中间宿主调用结果。

文本 artifact 可通过 fs.list('/artifacts')/Glob 列举，通过 Read/Grep 检查完整正文（包含 32000 字符之后）；fs.read 维持范围契约，建议返回 limit:2000 的小范围，避免再次触发 REPL 输出保存。根目录只读，禁止手工写入/覆盖/编辑/删除/重命名；自动结果不进入源码文件目录。结果卡片可打开只读分页视图或下载全文，按站点持久化并沿用 session 引用与 debug pack 文本工件导出规则。

自动保存失败不冒充执行失败或声称已有文件：返回有限预览和 output_save_failed warning，明确代码已经完成，不能重跑副作用来恢复输出。显式 output_file 继续保留其 /workspace 指定路径及冲突、额度、失败阶段契约，失败不偷偷转存 artifact。验收覆盖阈值边界、UTF-8、首尾预览、原文中段恢复、内部 state/执行次数、存储失败、模型请求、UI 和重载恢复。

---

### 9.7 最小自动上下文压缩

模型配置中的 autoCompactTokenLimit 默认 64000 tokens，0 关闭自动尝试，正数至少 1024。不增加压缩模型、比例或多轮校验配置。总输入估算包含 instructions、工具定义和历史，参考最近模型 input token 用量校准；不是模型窗口自动发现或精确 tokenizer，用户需为摘要和回复预留空间。

达到阈值且有可压缩历史时，在下次模型请求前，用当前模型发起一次无工具摘要请求。保留内容参考 Codex 交接提示词：用户目标、约束与偏好，已完成工作/决策/实际验证，剩余任务及下一步，关键数据、文件与工件路径。已有摘要与新覆盖历史合并，未知/失败/未验证的结果不得改写成成功。网页与工具文本作为不可信历史数据处理，不执行其指令。

摘要替换旧前缀，保留最近三组完整交互，工具调用及其结果不能拆开；必要时把最新用户要求原样保留。边界始终基于原始历史，避免 SDK 延续已压缩输入导致边界偏移。压缩期间排队的新要求在下一次正常请求前消费并持久化。原始 UI 对话、文件、工具输出与 REPL state 保持；不重启 Worker，不重放操作。

按 session 持久化 summary、coveredMessages、规范化前缀 SHA-256、时间及前后 token 估算。重载后校验原始历史匹配才复用；不匹配则保留完整历史。关闭自动压缩仍复用已有有效摘要；Clear context 清除摘要。面板刷新仍按原约定重建 REPL，不承诺从摘要恢复变量。

只接受 finishReason 为 stop 的完整摘要；length 等非正常结束即使有正文也不能建立 checkpoint。摘要输出额度包含推理开销，上限为 8192 tokens。摘要被截断、空摘要、未减少上下文、最近保留内容仍超阈值、网络或持久化失败时，保留此前上下文，同一 run 不重复自动尝试；新 run 可再次尝试。停止取消摘要请求并丢弃尚未完成的结果。状态栏提供进行中/估算/失败提示，调试导出记录当前阈值、摘要及覆盖边界。确定性验证不代表已证明模型摘要质量或原样本的成本改善。

## 10. R6：稳健性与暂缓项

### 10.1 REPL 语法错误定位

已实现：只在初始编译失败时读取 QuickJS cause 的 fileName/lineNumber/stack，确认来源为 agent-repl.js 后还原 async 包装偏移。QuickJS 实测按 LF 计行、Unicode 码点计列，需转换为与 Chromium 一致的逻辑换行及 UTF-16 列；两边共用 `(line N, column M)` 的 1-based 位置后缀。列未知时仅给行号；包装前后缀位置、非法或有歧义的位置不猜测。已有位置/文本堆栈不重复添加。

本期不添加 excerpt 或复制整个 cause/stack/details，只补缺失的位置。JSON.parse 等运行时 SyntaxError、普通运行时错误以及宿主/page_exception 的 message/code 保持，不把 JSON 内坐标或页面坐标映射为 REPL 编译位置。验收覆盖多行、emoji/组合字符、CRLF/CR/Unicode 换行、缺列、无位置、包装位置、代码只执行一次和完整 Worker/工具错误通道。

### 10.2 历史响应与流读取

不采用“Network.getResponseBody 超限后调用 Fetch.takeResponseBodyAsStream”的回退。后者要求请求已被 Fetch 拦截并暂停，而且只能顺序读取；它不是历史 Network requestId 的通用读取接口，也不能直接接受随机 offset。

本期分别验证源码宿主取体与 http.request 的显式返回/输入限额；现有 browser.responseBody 的小响应行为不变。后续若扩展历史大响应读取，应在验证浏览器保留能力后，设计明确的保存/引用语义，保持 session 参数兼容；不要为了分块读取引入默认全站请求拦截。

### 10.3 state 镜像不进入本期

保持 Worker 停止/超时后 state 丢失的现有契约，错误如实提示。优先让可复用数据保存到文件/工件。只有回放证明仍存在显著损失、且 JSON 可恢复性与开销可接受时，再单独讨论快照；不能宣称任意 JS state 都能无损恢复，也不能回放之前的宿主副作用。

---

## 11. 边界与兼容性

- 页面源码、响应体和文件内容是待检查的数据，不构成工具授权。browser 和 /source 限绑定 tab + owned sessions；http.request 仅显式请求参数指定的 HTTP(S) URL，使用扩展 host 权限，不扩大其他浏览器操作的范围。
- /source 只读；持久化工作区文件由显式 Write/Edit/fs.write 或 repl.output_file 产生，沿用相应的修订/冲突与额度规则。最终结果保存不改变执行中的函数返回值或脚本安装/验证契约。
- helper 可以提供摘要和错误定位；browser.send 保持原生 CDP 参数与返回字段。新增效果不通过隐式重跑用户代码实现。
- 保存的响应及源码 URL 可能含站点数据；调试导出沿用既有遮盖与审查纪律，新增保存路径必须进入测试。/source 的易失源码正文不自动导出；原始全文不会因为“只给模型预览”就自动成为可安全分享的数据。
- 不修改旧持久化消息；兼容历史工具名、REPL 参数和结果形状。guides/debug pack 的版本与实际能力一致。
- 已实现范围以文首和各节状态为准。output_file、Grep 字符窗口、/source、http.request、networks 原生日志读取、宿主 code/details、上述页面错误信息补缺、REPL 编译位置、大结果 /artifacts 保存及最小历史压缩已接入；函数源码传输等研究提案不能当作已可用能力。browser.requests/browser.fetch 没有注册。

## 12. 待验证决策

1. 真实 DevTools 资源 API 与 CDP 在现有 Chrome 135 基线上的覆盖差异，特别是 inline、eval、缓存、CDN、owned child session；不承诺复制整个 Sources 工作区。
2. sourcemap 是否有足够独立收益：先读取已知映射或 sourcesContent 的可行性，不默认递归下载外部源文件。
3. 原生资源 API 可能只提供 URL，没有 frame 身份时的歧义处理；不能凭 URL 将不同 frame 源码合并。
4. 源码单资源 8MiB、缓存 32MiB、扫描 8MiB 已实现；HTTP 响应当前采用 2MiB 解码体/3MiB JSON 桥接上限，请求正文 2MiB，不采用原 20MiB 候选值。repl.output_file 复用既有工作区额度；REPL 自动输出已采用 8 KiB 阈值、2 KiB 预览与 /artifacts 全文，不增加 max_output_chars。更大输入/存储额度另行验证。
5. 请求 helper 与摘要的真实使用率；当前保持六个顶层工具，后续新增入口须证明独立收益，不按调用频次直接复制 REPL 方法。
6. 最小上下文压缩已实现，摘要质量和真实成本收益继续按任务验证；函数源码传输、历史大响应扩展另行验证；state 自动镜像不预排实现。

## 13. 验证计划

| 层 | 内容 |
| --- | --- |
| 契约测试 | http.request 固定返回结构、完整 body、输入/桥接限额、并发与错误；repl.output_file 的显式模式、JSON 格式、元数据、create-only、执行/输出阶段失败；宿主 details 传播 |
| 源码与文件测试 | 只读挂载、URL/query/frame/script 身份、来源版本、预算、导航迟到结果、字符窗口定位/输出分页、普通文件工具回归 |
| 真实 F12 | DevTools getResources/getContent 的实际覆盖；脚本早于 Agent 加载、CDN、inline/eval、懒加载、已知 sourcemap 元数据。仅 fixture 不足以证明 DevTools API 可用 |
| 浏览器 fixture | CDP 资源/脚本路径；大响应在允许额度内可计算；传/不传 output_file 的执行语义一致；执行前冲突、运行中重名竞争、保存超限、取消/timeout/导航及请求摘要分页 |
| 对照回放 | 用脱敏合成 fixture 保留原问题结构；比较累计输入 token、请求/源码是否重复获取、手写包装代码、失败次数和证据链质量 |
| 导出 | 工具定义与 guides 一致，保存的文件/工件可恢复；不自动导出 /source 正文，新路径遮盖与错误详情有限输出 |

不能只用固定模型输出的脚本回放证明“模型会选对工具”。除确定性的契约验证，还应使用相同模型配置、任务与合成页面做前后对照；50% 输入 token 改善是待验证目标，不是新增几个接口后的既成结论。

## 14. 分期

| 阶段 | 交付 | 推进条件 |
| --- | --- | --- |
| 1 | 六个顶层工具保持；源码 API 能力验证；Grep 字符窗口；/source；http.request；repl.output_file 显式结果保存与按需读取；错误详情和当期 guides | 先验证取源、函数返回语义与输出边界，再做模型回放；不包含隐式 evaluate 重试或按大小替换函数值 |
| 2 | 已实现复用 F12 的只读 networks 及统一格式的 REPL 语法定位 | 不调整原生 Network 设置；验证 HAR 对齐、正文不重放、分页与位置来源 |
| 3 | 已实现最小历史压缩；函数源码传输、历史大响应扩展按回放结果选做 | 继续验证摘要质量和成本收益；其余改进不捆绑实施 |

原草案工期依赖尚未核实的 API 覆盖和传输假设，本轮不保留为承诺排期。实现顺序应先解决能够验证的契约和通路，再估算剩余工作。

## 15. 依据与源码入口

样本轨迹索引沿用原草案：repl[31]/[42]/[57] 为包装/转义问题，[73] 为错误响应形状误判；反复 bundle 扫描与 state.bodies 用法需在原 debug pack 可用时复核。不把未复核的统计当成新实现已通过回放。

当前源码入口：agent/tools.ts、agent/file-tools.ts、browser/session.ts、repl/contracts.ts、repl/runtime.ts、repl/worker.ts、repl/client.ts、protocol/errors.ts、devtools/controller.ts、workspace/service.ts、debug/export.ts。API 清单、校验、运行时注册和宿主分派目前分处多文件，新增能力须逐项对齐。

官方依据：

- [DevTools inspectedWindow 资源 API](https://developer.chrome.com/docs/extensions/reference/api/devtools/inspectedWindow)
- [DevTools network 原生 HAR/getContent/事件 API](https://developer.chrome.com/docs/extensions/reference/api/devtools/network)
- [CDP Debugger：scriptParsed / getScriptSource](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json)
- [CDP Page：getResourceTree / getResourceContent](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl)
- [CDP Fetch：拦截流的前置条件](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Fetch.pdl)
- [Codex ToolOutput：代码结果与模型输出接口](https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_output.rs)
- [Codex MCP/执行输出处理](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/context.rs)
- [Codex 执行工具的输出预算 schema](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/shell_spec.rs)
- [Codex hooks：large output spilling（仅该通道）](https://learn.chatgpt.com/docs/hooks#large-hook-output)
- [Codex 配置：tool_output_token_limit](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex 压缩交接提示词（本轮参考的固定版本）](https://github.com/openai/codex/blob/02390c8d8e39a9b72d12e04e83987d5eb6801310/codex-rs/prompts/templates/compact/prompt.md)

Codex 依据限于本轮读取的公开文档与 openai/codex main 实现；不同工具/版本的具体上限和留存能力不可混为统一产品保证。
