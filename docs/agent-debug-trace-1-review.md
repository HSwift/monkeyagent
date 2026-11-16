# DeepSeek 调试轨迹评估与 harness 改进

日期：2026-11-07。样本：本地 `debug/1.json`，配置记录为 `deepseek-v4.1-flash`，图片输入关闭。任务是在 GitHub 页面移除 `.copilotPreview__container`。只评估这一次轨迹，不据此推断其他模型或任务的表现。

## 结论

模型能够完成基础网页检查、脚本安装、刷新和回归排查，对项目 bridge 的掌握仍有明显缺口。主要问题是执行环境混淆、返回结构误读，以及验证证据不足。这份轨迹没有直接调用 `browser.send`，不足以判断原生 CDP API 的熟练度，不能把 bridge 使用错误归结为不熟悉 CDP。

## 轨迹证据

共 3 次运行、27 次已记录操作：6 次 files、21 次 repl，其中 19 次 repl 成功、2 次失败。实际开发任务持续约 119.3 秒，23 次已记录操作合计约 23.5 秒。剩余时间包含模型请求、网络和循环处理，导出记录不足以进一步拆分。

| 能力 | 观察 | 判断 |
| --- | --- | --- |
| 页面检查 | browser.evaluate 18 次，先检查实际 DOM 再选择目标 | 能完成基础页面求值和 DOM 分析 |
| 安装与验证 | reload 3 次、verify 8 次；通过 Monkey 安装后刷新 | 理解安装与网页执行的区别 |
| 故障定位 | 做动态插入探针；禁用脚本后刷新，对照定位相邻内容消失，随后修复 | 有实际排查能力 |
| REPL 环境 | 猜测存在 __hosts__；在 QuickJS 顶层使用 setTimeout 导致失败 | 没有稳定区分 REPL 与网页运行环境 |
| 日志读取 | 第一次把事件数组当作含 events 字段的对象，过滤结果恒为空；第二次修正回退，但筛选条件仍可能漏掉异常 | “没有相关错误”的结论缺少可靠证据 |
| 导航等待 | 先改 location 再注册等待，存在错过事件的风险；部分等待错误被 catch 忽略 | 对异步操作顺序和失败结果处理不够严谨 |
| 验证范围 | 起初额外删除空父容器，影响解析器随后插入的内容；一度把相邻内容消失作为通过条件 | 需要保留原任务边界和正向不变量 |
| 证据解释 | 对 STYLE 元素检查 computed display；图片输入关闭时仍截图；根据单个类缺失推断登录状态 | 能力调用成功与证明需求满足之间有断层 |
| 原生 CDP | 未出现 browser.send、contexts、responseBody 或直接 Debugger/DOM/Input 命令 | 样本未覆盖，暂不评分 |

第一次日志筛选的关键问题如下。events 实际为数组，条件成立，但真正执行过滤时取了不存在的 events.events，最终始终过滤空数组：

```js
const relevant = (events.events || events || []).filter
  ? (events.events || []).filter(/* ... */)
  : [];
```

这应通过明确 bridge 返回契约、提供正确示例和验证检查来解决，无需改变 CDP。

## 复审：验收中的额外陷阱

以下索引均为原始 `operations` 数组的 0-based 索引。已发生的错误、结论超出证据和本地复现的覆盖缺口分开记录，不把所有风险都当作原页面已经出错。

| 问题 | 轨迹证据 | 影响与修正方向 |
| --- | --- | --- |
| 用常量充当读回结果 | operations[21] 的页面检查直接返回 `version:'1.0.1'`，并把非空 status 映射为 `{installed:true}` | 本次文件确实写成 1.0.1，但这种检查无法发现安装版本不符或状态异常。版本应从已安装快照的元数据读取；安装状态应检查实际 state 和修订，不填预期常量。 |
| 猜测状态字段且没发现缺失 | operations[26] 读 `st.verified`，结果序列化后该字段完全消失；真实结构为 `verification.passed` | 模型没有检测字段缺失。该次另有真实 verify 返回 true，因此不能说任务完全没验证；问题是状态读取没有起到交叉检查作用。旧指南未明确字段形状也是诱因。 |
| 用无目标页面证明删除能力 | operations[25] 在 /features 读到目标数 0、删除计数器 0、样式存在，随后称其他路径验证通过 | 只证明该 URL 有注入证据、目标不存在，未触发删除功能。也没有实际测试站内软导航；通过 location.href 的整页跳转不能充当软导航测试。保留当前任务所需的验收范围，未覆盖的变体不要计为通过。 |
| 将最终状态扩写成时序保证 | operations[12] 等待两次 requestAnimationFrame 再等 200ms；operations[22] 等待两次 requestAnimationFrame 再等 250ms，随后观察节点消失 | 只能证明在检查时已经删除，无法证明“同一帧内删除”。插入后立即观察到 display:none 也是一个时点的证据，不能据此保证所有加载场景“一刻不闪、不会布局跳动”。 |
| 从总高度变化推断精确布局效果 | 首次目标高度记录为 265px；后来的两次加载中 dashboard 高度 1125→1109，最终报告把 16px 差值说成正好是面板占位、没有残留空白 | 不同加载阶段的总高度不能直接归因于目标本身。应比较相同就绪条件下的目标和邻接元素布局；现有证据不足以支持这个精确解释。 |
| 容器存在检查被当作完整保留检查 | operations[22] 的 v2 只检查 .news、feed-container 和 dashboard 的存在，最后一次 verify 只剩目标不存在及 feed-container 存在 | 空的 feed-container 也能通过，因此这属于结构冒烟检查。不能据此证明内容、可见性、交互及 React 水合全部正常；按风险补充少量实际内容/功能不变量，并明确未测范围。 |

### 最终脚本的动态处理缺口：已在隔离浏览器复现

直接运行导出文件中的 v1.0.1，在隔离的真实 Chromium 页面比较两种情况：

| 场景 | 300ms 后结果 |
| --- | --- |
| 新插入一个已经带目标 class 的节点 | 被删除，删除计数器递增 |
| 已在 DOM 中的普通节点随后获得目标 class | 节点仍在 DOM 中，display 为 none，计数器不变 |

原因可从代码直接看出：MutationObserver 只订阅 `childList/subtree`，未订阅 class 属性变化。第二种情况不会触发删除扫描。CSS 仍能隐藏节点，所以这不等于用户一定看见了残留面板；但它不满足模型所宣称的持续从 DOM 删除所有匹配节点。原始轨迹只测了第一种情况，没发现这个缺口。是否补充 class 变化监听应依据实际页面行为和需求决定，无需无差别监听全部属性，也无需改变 CDP API。

该轮复审只补充评估文档，未调整 harness、bridge 或生成的用户脚本。隔离页面复现用于验证上述代码行为，不是对 GitHub 当前页面或真实 DeepSeek 的新一轮测试。

### 后续通用工具修正的范围

后续实现只改工具契约、可靠性和诊断，不提供任务模板，不增加特定模型的特例或隐式纠错：

- 工具输入和自有 bridge 参数严格校验，错误直接返回；原生 CDP 参数仍由浏览器校验并原样传递。
- REPL 返回值中的 undefined 丢失提供通用序列化诊断，正常 JavaScript 属性访问不变；警告不会使已成功执行的操作变成失败。
- scripts.apply/status 提供宿主快照中的实际版本及修订。status 在工作区修订不符、外部修改或禁用时返回 verification:null；verify 检查当前宿主启用状态。
- docs 说明执行成功、断言通过和任务满足之间的区别，明确覆盖与证据边界。没有实现自动断言、测试套件或导航关联，业务验证仍由模型负责。

## 接口改进的边界

项目自己的 bridge 可以调整参数、默认值、返回摘要和错误提示，让模型更容易正确使用。原生协议入口保留 CDP 的命令名、参数名和返回字段，不为了迁就某个模型改协议，也不向 CDP 参数中混入 helper 选项。

| 层次 | 本次处理 |
| --- | --- |
| browser.send / 原生 CDP | 保留协议结构；增加与直接 chrome.debugger 调用比较的测试，确认 Runtime.evaluate 的结果及 exceptionDetails 不被解包 |
| 自有浏览器 bridge | navigate/reload 在发送命令前注册等待；events 支持 tail 取得日志游标；evaluate 保持“返回页面值、页面异常抛错”的便捷语义 |
| REPL | 增加可取消 sleep、明确缺失全局的提示；不模拟整个浏览器或 Node 环境 |
| 文件工具 | 按此前需求提供 Read/Write/Edit/Glob/Grep 的常用参数；自动记录读到的修订，保留并发冲突检查 |
| 工具结果 | 自有写入与安装接口返回摘要，减少重复源码；读取接口仍提供正文 |
| harness 缺陷 | 修复空或重复消息 ID、可恢复工具输入错误导致整次任务误标失败、终止错误被后续错误覆盖；记录步骤和 provider 提供的 token 用量 |

原生 CDP 返回中的 exceptionDetails、Page.navigate.errorText 等仍是协议返回字段。它们不能被“协议调用成功”掩盖；调用者需要检查。项目约束如当前标签页范围、句柄有效性和返回大小限制仍由传输层执行。

## 给 Agent 的指南

指南作为打包的只读 Markdown 出现在虚拟文件系统 `/docs` 中，模型通过 Read 工具按需读取。系统提示给出入口，不新增界面或另一套 skill 执行框架。

- [开发总指南](../packages/devtools-agent/src/agent/guides/agent-guide.md)：最小改动、安装、验证和停止条件。
- [浏览器接口](../packages/devtools-agent/src/agent/guides/browser-api.md)：区分项目 helper 与原生 CDP，明确参数和返回形状。
- [调试工作流](../packages/devtools-agent/src/agent/guides/debugging-workflow.md)：执行环境、日志分页、失败诊断、内容保留检查。
- [文件工具](../packages/devtools-agent/src/agent/guides/file-tools.md)与[脚本接口](../packages/devtools-agent/src/agent/guides/script-api.md)：编辑、修订、安装及 verification.passed。

这些是提供给模型的使用指导，不能保证模型遵守。自动测试覆盖工具和 harness 行为；是否减少 DeepSeek 的错误，需要在相同模型配置、页面与任务上重新跑任务并比较轨迹，当前没有进行真实模型的改前/改后对比。

参考：[chrome.debugger 的 CDP 传输与支持范围](https://developer.chrome.com/docs/extensions/reference/api/debugger)、[Runtime.evaluate 原生契约](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate)、[Page.navigate 原生契约](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-navigate)。
