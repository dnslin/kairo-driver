> 已归档：T01、T02、C1 已完成，PR #1 于 2026-10-08 合并，合并提交为 `1734649429b261a7d730af6a0f3c4d9b3326c1f7`。
> 以下为历史交接原文，不再作为新阶段执行指令。后续 T03 交接现保留在 `tasks/archive/T03-handoff.md`，当前交接见 `tasks/T05-handoff.md`；本文件旧的“只读私聊”授权不覆盖后续用户新增的真机测试授权。

# Orca 交接：顺序实施 T01 → T02

## 身份、范围与所有权

你是 `D:/Person/kairo-driver` 当前工作区内 T01 和 T02 的唯一实施代理。用户授权通过 Orca CLI 派发这两项任务，担心共享文件冲突，并要求任务明确必用 SKILL 与 MCP。

这是完整任务交接，不是监督型 Dispatch；不要创建 Orca Run/Task/Dispatch，不要发送 worker_done 生命周期消息。原会话在确认交接成功后停止编辑业务代码。两个任务由你依次执行：T01 完成并通过其验收后再启动 T02；不能并行编辑两项任务，也不要另开一个代理修改它们的共享文件。

只实施 T01、T02 及其必要的调用方更新。不实施 T03–T12，不重新设计发送结果、机器人分类、连接生命周期或全部媒体；这些后续方案不能被当作当前实施范围。不要整体删除 src/dom，不新增兼容层、旧 API 别名、假字段或 DOM 回退。

当前工作区含前序调查和方案，可能有未提交内容；必须保留用户现有修改，不 reset/clean/stash，不自行提交、推送或切分支。依照 AGENTS.md，交流、日志和代码注释使用中文。方案与证据必须先读，不能凭交接摘要直接实现。

## 必须读取的 SKILL

开始前：
- `using-agent-skills`：确认适用流程与技能入口。
- `incremental-implementation`：按完整能力切片实施，维持现有可用能力。
- `test-driven-development`：行为变化增加或更新外部可观察的行为回归。
- `api-and-interface-design`：身份、原生会话 ID 与错误结果的契约；复用现有模式，不另起框架。
- `git-workflow-and-versioning`：尊重工作区现有修改；导出改变前追踪调用，不自行提交。
- `js-reverse`：使用 jshookmcp 核对真实 KK9 回包与客户端源码，读取技能要求的取证规范。
- `orca-cli`：本次通过 Orca 交接，必要时读取当前版本的 `orca skills get orca-cli`；不使用原会话的终端句柄发送工作。

相关操作前：
- `debugging-and-error-recovery`：发生构建、测试或真实运行失败时使用；不能通过弱化断言或吞错解决。
- `documentation-and-adrs`：行为与公开契约变化同步更新已有说明，不增加无关文档体系。
- `code-review-and-quality`：结束前核对本次改动的质量与调用方覆盖。

每个匹配技能都先读取实际内容，不把名称列表当作已经执行。不得使用 agent-browser 工具代替用户指定的 MCP。

## MCP 与代码工具

### 必用 MCP：jshookmcp

用途仅限真实 KK9 的只读连接、身份对照、原生会话和历史元数据查询、必要源码证据。通过实际提供的 `search_tools` / `describe_tool` / `activate_tools` / `call_tool` 路由确认 `electron_attach` 等工具的真实 schema，不猜参数。

已挂载路由包含：
- `xd://mcp__jshookmcp_search_tools`
- `xd://mcp__jshookmcp_describe_tool`
- `xd://mcp__jshookmcp_activate_tools`
- `xd://mcp__jshookmcp_call_tool`

当前共享 MCP 进程此前遇到过 Electron/Playwright 适配错误；修复后的独立 jshookmcp 进程已经成功验证。不要因此绕过 jshookmcp，也不要盲目重启或修改共享工具环境。可复用仓库已有脚本启动修复后的独立 MCP：

```text
node tmp/kk9-native-readonly.mjs C:/Users/dongshilin/AppData/Local/npm-cache/_npx/54329d0b0943287e
```

该脚本使用 MCP SDK 调用 jshookmcp/electron_attach，仍属于 jshookmcp 路线，不是 agent-browser。不要重新实现一套浏览器工具或把旧探针成功冒充新 SDK 方法验收。

### 必用代码导航：xd://lsp

这不是 MCP。改公开导出或类型前读取工具文档，使用 references 查受影响符号；定义、引用、改名和代码操作用可用的语言服务。查询只覆盖其所见项目，不代表测试和示例自动全部覆盖，仍须完整核对调用与运行结果。

文件读取、编辑、创建分别使用平台 read/edit/write。不要用 shell 文本替换或大范围格式化修改无关代码。

## 必读文件与现有证据

- 仓库 AGENTS.md、docs/DEVELOPMENT.md、docs/KK9-STARTUP.md。
- `tasks/plan.md`：重点读契约决策、T01、T02以及检查点C1；后续任务只用于理解边界。
- `tasks/todo.md`：只更新完成的T01、T02与其检查点状态；其他任务保持未完成。
- `tmp/kk9-native-investigation.json`。
- `tmp/kk9-native-readonly-evidence.json`。
- `tmp/kk9-native-readonly.mjs`。
- `tmp/kk9-native-snippets/index.json` 与 T01/T02 相关的原生函数片段。
- 实际实现、公开类型、Fake、相关测试、示例与运行配置；改前完整理解相关调用路径，不凭文件名或孤立片段实现。

已确认事实：
- 当前登录账号 `0123040139`，UID `5761`。
- 授权测试目标 `int2024`，UID `3585`，唯一现有私聊 native sessionID `716791`，原生类型 `0`。
- `0-3585` 是客户端界面标识，不是 native sessionID，也不是用户 UID。
- 原生无参数 `getMemberDetail()` 默认查询 CORE_DATA.userID，真机成功取得当前身份，无需先从 Vue 读取 UID。
- 原生 `getConversations()` 和 `getMemberDetail(3585)` 已取得目标映射。
- `getMessages({sessionID:716791,count:10,endIdx:2147483647,sendTime:0})` 已返回十条历史的必要元数据；读取前后 userReadIndex 都为660。
- 档案 getter 不返回 deviceID；预插入设备字段要求仍须读取真实源码确认。此项是向 T03 提供证据，不准用空值伪造解决，也不准因此试发送或预插入草稿。
- 没有真实新入站、发送、撤回或媒体验收；不能把取证结果说成这些能力已经跑通。

## T01：原生身份与会话读取

### 修改目标

核心：`src/driver.ts`、`src/bridge/session-ops.ts`、`src/types/index.ts`、`tests/bridge-session-ops.test.ts`、`tests/driver.test.ts`。受影响的 Fake、公开导出、调用方和已有说明同步更新，避免新会话 ID 让员工查询、发送路由等现有调用读错对象。

### 契约

- 当前登录身份从原生接口取得，不从 DOM/Vue 或配置值伪造实际登录用户。
- 会话公开 id 使用 native sessionID 的字符串形式，目标为 `716791`；用户 UID、接收对象、原生类型含义分别明确。
- 界面事件名如0-3585需要时只在内部转换，不引入公开旧 ID 兼容别名。
- 私聊覆盖 typeID 指向对端与 typeID 指向当前账号的创建方向，以真实字段解析接收对象，不能盲目使用 `typeID || sesTypeID`。
- 不把未知/其他原生类型折叠为私聊。空会话是正常结果，原生查询异常必须保留诊断，不吞为空数组后自动回退 DOM。
- 窗口状态不作为读取的数据来源。不顺带清理后续任务才移除的整个窗口 API；契约受影响的调用在当前切片完整更新。

### 可观察验收

1. 身份和会话查询实现不调用 document.querySelector、读取 __vue__ 或编辑器 sortedSessions。
2. 会话 ID 与接收对象正确，覆盖私聊两种方向、空列表与失败；Fake和必要调用使用一致契约。
3. 真机不切窗口即可取得已授权账号与目标；设备字段要求用只读源码证据记录，未确认的 getter如实标明，不执行草稿插入。

完成整套修改后运行相关行为测试与 pnpm check；真实环境通过 jshookmcp 核对。再运行修改后的真实 SDK 读取路径，不能只跑旧探针。根据实况更新已有文档和 tasks/todo.md 的T01项。T01失败或未完成时不得假装完成后启动T02；修复可达问题，确实缺真实前提时说明缺项。

## T02：明确目标的历史读取

硬依赖：已完成T01及其会话契约。不要从旧快照重新定义同一类型。

### 修改目标

核心：`src/bridge/message-ops.ts`、`src/driver.ts`、`src/types/index.ts`、`tests/bridge-message-ops.test.ts`、`tests/message-ops.test.ts`；对应真实脚本、Fake、调用方与说明同步更新。

### 契约

- 读取历史必须显式指定原生会话，直接调用 getMessages，不依赖当前激活聊天、编辑器、sortedSessions、可见消息气泡或名称模糊匹配。
- 所有返回消息使用与T01一致的会话身份，原生消息 ID 和消息索引不混用。
- 历史结果不重放为实时message/recalled事件，不把历史撤回当新撤回。
- 空页、缺页、原生失败按真实行为处理，不新增猜测补页、自动重试或兼容 fallback。
- 只删除这一条历史读取路径的 DOM 回退，不实施自动轮询重做、发送状态重做或整体DOM裁撤。

### 可观察验收

1. 明确会话 ID 直接传原生getMessages，聊天组件不存在或窗口显示其他会话也不改变读取目标。
2. 返回会话与消息ID正确，历史不产生实时事件；空结果与失败可区分，必要边界有行为回归。
3. 真机读取前后已读索引未变化，无切换、标记已读或其他聊天操作。旧脚本的窗口切换依赖被移除，身份核对门禁保留。

完成整套修改后运行相关历史测试与 pnpm check；真实执行更新后的SDK历史路径，用 jshookmcp 对照原生元数据和读取前后读索引。更新已有说明、T02与C1状态；C1只有两项都通过才勾选。

## 真机权限与验证底线

本次只允许当前已核实账号与 int2024 既有私聊的只读身份、会话、历史查询。不得发送、撤回、切换、创建会话、标记已读、预插入草稿，不扩大到群或其他目标。只保存必要的类型、身份、ID、索引、结构和错误上下文，不保存聊天正文或凭据。

查询函数内部正常刷新档案/头像/本地历史缓存不等同聊天操作，但必须准确说明实际行为。

用户已有观察和失败是事实，不重新跑检查去“确认用户说的对不对”。不要弱化断言、删真实失败回归、硬编码授权数据或用静默 fallback让检查通过。授权目标只存在于真机脚本/环境和证据，不能写入生产逻辑。

不添加只测实现细节、源码字符串、转发或mock回声的永久测试；测试应捕获消费者可观察的身份/目标错误、空/失败边界与历史事件语义。真机不存在时完成可达代码与行为回归，清楚报告未验证项，不把替身当真机通过。

## 完成与交付

结束前进行本次范围的代码质量检查，确保所有受影响源码、Fake、测试、示例、公开导出与说明已更新或确有理由保持不变。

分别报告T01、T02：实际结果、修改文件、实际运行的命令与结果、真机证据、未验证项或阻塞。没有运行的检查不得说通过；不要把任务开始或中间阶段说成完成。

两个任务完成后停止，不自行执行T03。保留用户现场与授权边界，不自行提交或发布。
