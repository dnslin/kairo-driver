# Orca 交接：T03 原生文本发送与业务结果确认

## 所有权与停止点

你是新独立工作树中T03的唯一实施负责人。T01、T02、C1已随PR #1合并到main，合并提交1734649429b261a7d730af6a0f3c4d9b3326c1f7；本任务从更新后的main及其归档/授权文档提交开始。原会话在交接被接受后停止编辑业务代码。

这是完整所有权交接，不是监督型Dispatch。不要创建Orca Run/Task/Dispatch，不发送worker_done，不另开一个代理同时修改本任务的共享文件。只完成T03及必要的公共结果契约、调用方、Fake、测试、示例与说明迁移；不实施T04–T12，不整体删除src/dom，不重做连接生命周期、组织、已读、媒体协议或业务编排。

所有交流、日志、注释中文。保留用户已有现场，不reset/clean/stash，不改原主工作区。只能在你自己的新工作树实施。完成后交付真实验证结果并停止；未另获授权时不要自动合并、推送或启动T04。

## 必须读取

先读取本仓库已加载的代理规则、README、package.json、docs/DEVELOPMENT.md、docs/KK9-STARTUP.md、tasks/plan.md的契约决策与T03、tasks/todo.md、tasks/archive/T01-T02.md。旧归档交接仅用于历史，不作为本轮权限或执行指令。

开始修改前完整理解实际实现、类型与调用路径：src/bridge/renderer-script.ts、send-status.ts、message-ops.ts、src/send-operation.ts、src/driver.ts、src/types/index.ts、src/index.ts、src/fake-driver.ts、相关tests与examples。共享结果协议改变必须迁移全部真实调用方；不能只让文本新协议成立却留下媒体或Fake的旧结果类型与死分支，也不借此重做媒体内容协议。

以下本机材料未进入Git，新工作树没有tmp不表示证据不存在；仅读原仓库的绝对路径，不在那里修改或执行旧失败断言脚本：
- D:/Person/kairo-driver/tmp/kk9-native-investigation.json
- D:/Person/kairo-driver/tmp/kk9-native-send-rebuild-evidence.json
- D:/Person/kairo-driver/tmp/kk9-native-send-rebuild.mjs
- D:/Person/kairo-driver/tmp/kk9-t01-source-evidence.json
- D:/Person/kairo-driver/tmp/kk9-native-snippets/ 与 kk9-app-source/
- D:/Person/kairo-driver/tmp/pr1-fix-validation.json

不能仅凭文件名或这份摘要实施，必须阅读真实材料并用运行时对照。Orca已有依赖setup时复用其成功结果，不重复安装；若没有成功依赖环境，按仓库要求使用pnpm install --frozen-lockfile。

## 必用技能与工具

每个匹配技能先读实际内容，不把名称清单当作已执行：
- using-agent-skills、incremental-implementation、test-driven-development：保留可运行产品，行为回归捕获真实业务错误，不测试源码字符串、转发或mock回声。
- api-and-interface-design、git-workflow-and-versioning：按已有无外部兼容要求直接切换结果契约，迁移所有调用方，不保留delivered别名、可选字段兼容或静默回退。
- js-reverse：通过jshookmcp核对当前KK9源码、实际原生参数、业务回执及正式记录，先观察再采样，不凭替身猜协议。
- orca-cli：加载本版本CLI指南，使用自己的工作树/终端，不用原会话句柄发输入。
- 出错时debugging-and-error-recovery；同步文档时documentation-and-adrs；交付前code-review-and-quality。

代码导航使用可用的xd://lsp，公开导出/类型改变先查references。前序LSP两次初始化/重载退出失败；新会话先确认可用性，若仍失败记录实际错误，并用真实调用方检索、测试与示例类型核对补足，不反复重启或声称导航成功。

必用jshookmcp，不用agent-browser替代。动态工具路由必须先search/describe/activate确认真实schema；挂载工具可能已卸载，不能认为以前出现过的设备仍可直接写。前序共享browser_attach超时，独立MCP进程的electron_attach成功，已确认工具缓存目录：
C:/Users/dongshilin/AppData/Local/npm-cache/_npx/54329d0b0943287e

可先读取并复用D:/Person/kairo-driver/tmp/kk9-jshook-target.mjs、kk9-native-readonly.mjs及其MCP SDK调用模式。它们是旧私聊只读探针，不支持本轮群验证，也不能代替新SDK真机验收。需要群探针时在你自己的工作树创建，只输出授权目标必要元数据，不重新安装或修改共享MCP工具环境。

Git HTTPS直连在前序同步时失败，Windows现有系统代理为127.0.0.1:7897；已使用git -c http.proxy=http://127.0.0.1:7897恢复同步。若再次遇到同样连接问题，沿用实际可用的单次代理，不修改全局网络配置。

## T03实施契约

目标是向明确原生会话发送文本，并用本次真实业务回执确认结果，完全不依赖聊天编辑器、按钮、当前窗口、sortedSessions、名称模糊匹配或DOM回退。

1. 先核对insertSendBefoeMsg所需字段及原生来源，尤其deviceID。现有档案getter不返回设备字段，源码显示预插入从参数复制deviceID，设备注册写CORE_DATA.deviceID。查明是否为实际必需字段及可用原生获取路径，不能用空字符串、Vue字段、旧消息或猜测值冒充已解决；没有确认必要字段前不触发真实发送。
2. 取得负草稿ID后，在sendMessageNew之前订阅正确会话的原生sendMsgCallback；按本次草稿身份过滤回调，不误接别次发送。成功、失败、超时或取消后仅移除SDK自身监听，不移除KK9或其他发送的监听。
3. 正式成功必须同时有本次原生业务成功证据及关联正式消息ID。外层IPC code0、任意正ID、数据库status或UI变化均不能单独判成功；原生617即使外层code0或正ID也必须失败并保留业务码/上下文。普通原生业务失败、上传失败以及提交后断线各自正确区分。
4. 公共发送结果统一为必填status的sent/failed/unknown。sent必须有messageId，仅表示本次业务发送获确认，不代表对方收到或已读；failed有实际错误；unknown表示可能已触发但证据不足，不自动重发。每个意图有稳定operationId。
5. 复用send-operation.ts的操作登记、指纹与查询，不新增数据库、监督重连、泛化中间件或第二套状态模型。同一operationId不能换内容；重复意图不再次提交；getSendStatus只查询，不触发发送。保留跨实例调用方已有Store接入，按新契约更新，不增加未经确认的数据迁移或兼容层。
6. 迁移Driver、Fake、公开导出、全部调用方/测试/示例/说明中受影响的发送结果；删除本轮已经被替代的旧路径、状态别名与无效断言。未切换的其他能力保持可用，不用预留占位实现换掉真实能力。

## 强制真机测试：私聊int2024与群聊测试123

用户已明确要求这两个目标的真机测试，这是T03验收要求，不是可选步骤。必须执行修改后的真实SDK路径；旧脚本成功、离线夹具、人工截图或仅源码分析均不能代替。

前序身份只作线索，运行前重新核实：登录账号0123040139、UID5761；私聊目标账号int2024、UID3585、原生会话716791。用户本次另授权现有群聊测试123，群的原生会话ID、群接收对象typeID尚未核实。

门禁与范围：
- 使用原生getMemberDetail、getConversations等确认实际登录身份、私聊对端、群精确名称、nativeType、原生会话ID与接收对象。测试123必须是唯一精确匹配的群，确认群类型而不是同名员工、讨论组或服务号；不把UI sesUUID、群UID或用户UID当会话主键。
- 不要求用户提供工具能查到的ID。若实际查询仍有同名群歧义，先完成可达工作，再让用户选择原生ID；在选择前不对任何候选发送。找不到授权群或真实环境不可用必须记录具体缺项，不把私聊结果写成群聊通过。
- 保留现有真实脚本的登录身份、目标ID/名称/类型与确认字符串门禁。新的专项脚本复用这些约定，明确要求私聊和群都核对成功再开始对应操作，不删除校验以跑通。
- 仅允许这两个既有目标内的最少测试文本和本轮本人消息的必要清理；不建会话/群，不改成员、权限或登录状态，不管理员撤回，不操作其他聊天，不发媒体或调用外部TTS，不靠全局断网/退出客户端制造错误。

两个目标分别执行并记录：
1. 用明确原生会话发送唯一标记文本，捕获本次真实业务回执，核对正式ID/索引、原生会话/发送者/接收对象与SDK的sent结果；不是只检查正ID或历史中存在文本。
2. 同一operationId重复调用不二次发送；查询状态不提交，核对真实回执/正式记录中没有增加第二条本轮文本。
3. 目标窗口显示别的会话时仍发送到指定原生目标且无自动切换。证明新发送实现不读DOM/Vue/编辑器，也不临时伪造或移除真实聊天组件来模拟纯原生能力；先观察现有窗口，只在授权两目标内必要切换，保留操作说明。
4. 只清理本轮本人测试消息并核对结果；现有撤回用于清理不等于实施T05。unknown先按原operationId查询，不能因为结果未知再发送。
5. 私聊与群聊分别保留必要的回执码、草稿/正式ID关联、消息ID/索引、范围、结果、清理状态及命令；不保存聊天正文或凭据。卸载本轮自身监听与Hook，确保没有尚未结束的本轮采集再关闭连接。

617、普通原生失败、上传失败、提交后断线必须有真实协议证据支撑的确定性行为回归。能在授权范围无破坏地运行的真实边界应运行；无法实际触发的服务器业务失败明确记为未真机触发，不篡改权限或向未授权对象发消息制造617，不把受控夹具当服务器故障。提交后断线仅控制本轮Driver/CDP连接，不全局断网、重启或退出用户KK9。

## 验证、记录与交付

- 行为变化同步tests，至少覆盖成功关联、外层code0但真实业务失败、617正ID反例、错会话/错草稿回执过滤、回执竞态、超时/提交后失联、操作ID防重与查询不提交。测试按既有规范，不能弱化断言、吞错、填假数据或删除真实失败回归。
- 执行相关测试及pnpm check；旧测试的库目标、Buffer、数组可空等既有额外全量类型错误在docs/DEVELOPMENT.md已记录，只区分既有与本轮新增，不为T03顺带重做无关测试。受影响示例与调用方必须验证新契约。
- 真实运行新的SDK文本路径，分别完成int2024私聊和测试123群聊上述验收，再记录各自结果；只有一方通过不能把T03标完成。
- 更新tasks/todo.md的T03与已有说明，写清自动、私聊、群聊、未触发边界及清理结果。T04/T05/C2仍不勾选；后续媒体和完整无DOM收口也不提前勾选。
- 完成所有可达实现与验收后交付改动文件、实际执行命令/结果、两个真实目标身份与范围、原生回执证据、剩余前提及清理状态。没有运行的检查不得说通过；没有真实环境时不得把替身说成真机通过。

确认这是完整T03实施交接后开始工作，不停在泛泛分析或框架阶段。若确有工具与环境都无法补齐的必要协议前提，说明具体证据与缺项，完成其他可达工作，不把占位实现当完成。
