# 原生 SDK 改造实施清单

状态：T01、T02、C1已随PR #1归档；T03已随PR #2合并，基线d5e7791c9cc9a8a932367672985cebfde7242b1b。T04实现与自动检查已完成，双目标SDK回显、真实新入站、本机人工本人消息、历史、防重、组件重建以及真实组件缺席时的SDK回显和群入站已实测。按用户要求停止补测，已清理本人消息和自有监听；剩余未验证项原样记录，T04不勾选。不实施T05/C2及后续任务，不自动提交、推送、开PR或合并。

契约、核心文件、验收条件和验证方法见 [plan.md](plan.md)。严格按依赖执行；每个切片保留可运行产品，同步调用方、Fake、测试和说明。不得为过渡新增兼容层或隐式DOM回退。

## 原生读取

- [x] T01：原生身份与会话读取；统一native会话ID，确认私聊接收对象与草稿设备字段要求。
- [x] T02：指定会话原生历史读取；不切窗口、不标记已读、不重放实时事件。
- [x] C1：相关行为测试、`pnpm check`和授权真机只读验证通过；未切换能力仍可用。

T01 验证：`pnpm check`（30个测试文件、359条测试及build/typecheck/lint）通过；jshookmcp 原生对照与修改后的 `examples/verify-native-readonly.ts` 通过。实际登录UID5761，原生会话716791，对端UID3585。设备预插入从参数复制deviceID，注册来源为CORE_DATA；只读设备getter未确认，未插入草稿。证据见 `tmp/kk9-t01-t02-validation.json` 和 `tmp/kk9-t01-source-evidence.json`。

T02 验证：相关历史回归97条通过；随后历史、Fake、归一化和日志回归141条通过；最终 `pnpm check`（30个测试文件、364条测试及build/typecheck/lint）通过。修改后的SDK读取十条历史，与jshookmcp原生结果逐条核对消息ID/索引；userReadIndex读取前后均为660，无实时事件。调用方补充原生ID与同号UID碰撞、私聊反向创建接收对象回归，未进行真机发送。完整范围的离线变异核对也捕获反转私聊条件造成的错误接收对象。原有自动轮询和补偿扫描仍保留窗口操作，属于T11，不用于本次只读验收。群聊、新入站、发送、撤回和媒体真机场景未验证。

审查收口：R1–R6已修正，针对性9个文件223条测试通过，`pnpm check`的30个文件394条测试及build/typecheck/lint通过。int2024私聊中两条本轮测试文本均已撤回；撤回原生范围与去重、历史撤回状态/类型、轮询不重放以及退出后Hook清理通过，独立jshookmcp原生后验一致。空身份、列表缺席及C/D后缀边界由自动回归覆盖。新增脚本为 `examples/verify-native-regressions.ts`，详细结果见 `docs/KK9-STARTUP.md`，本机证据见 `tmp/pr1-fix-validation.json`。额外全量测试类型检查仍有既有库目标、Buffer与数组可空诊断；本PR新增会话字段失配已消除，不把额外检查记成通过。

T01/T02及前序审查仅验收读取与既有发送/撤回回归，没有完成T03；以下T03记录是本独立工作树新增的实现与验收，不追溯修改前序归档结论。

## 最小文本闭环

- [x] T03：原生文本提交与本次业务回执；草稿关联、sent/failed/unknown、617正ID反例与操作ID防重，私聊/群聊分别真机通过。
- [ ] T04：原生实时消息与自身回显；实现、自动检查及双目标核心真机行为已验证，按用户要求停止继续补测并清理交付；未完成全部命名验收，详见下方记录。
- [ ] T05：显式目标撤回；核对SDK主动、远端与客户端手动撤回，不丢本地通知。
- [ ] C2：真实文本双向收发、回显与撤回通过；错误与断线边界有行为回归，`pnpm check`通过。

### PR 初始 T03 验收

T03自动验收：相关15个文件、201条行为回归通过；最终 `pnpm check` 的build/typecheck、32个文件363条测试及lint全部通过。删除已被替代的DOM发送、旧success/delivered判别、自动重试与假成功断言，以执行实际生成脚本的原生回执回归替代；保留未切换的撤回、窗口、历史、富文本与媒体内容准备能力。617、普通失败、上传失败码-9、错草稿/错会话、回执先到、超时/提交后断线、重复不提交、查询不提交均有协议支撑的确定性回归。内存中反转617判别条件后，失败断言确实捕获正ID误判成功；未修改源码文件进行变异。

T03真机命令：`cmd /c "set KK9_REAL_TEST_CONFIRM=5761:716791:793803&& set KK9_STAGE1_CONFIRM=5761:3585:716791&& pnpm exec tsx examples/verify-native-text.ts 5761 0123040139 716791 3585 int2024 793803 29467 测试123"`，最终运行ID `388017e3-456a-4312-a989-2860b21a5747`。重新核对登录0123040139/5761、私聊int2024/3585/716791、群测试123/793803/29467/nativeType1；同名群716827/26519未经选择，未发送。私聊正式ID137443977/索引673，群137443981/索引113，提交后断线137443985/索引674；各自草稿-26、回执code0、无业务失败、正式设备33039。断线初始unknown，复用Store创建新Driver后查询sent，未重发。

私聊发送前后窗口均为793803，群均为716791；不读DOM/Vue/编辑器的发送实现在实际另一窗口上完成指定路由。每个意图只有一次原生提交，重复与查询都没有增加第二条消息。三个最终消息均已撤回并核对C/D标记，退出后本轮采集无残留、DriverHook无残留、在途0。617禁发、普通服务器业务失败与上传失败未真机触发；未发送媒体、改权限、管理员撤回、建会话、重启KK9或全局断网。现有撤回仅用于清理，不算T05验收；没有员工新入站，C2不勾选。

保留全部运行清理证据：第一次业务回执包装错误导致unknown，私聊137439705已撤回；第二次群SDK结果sent但专项采集监听被聊天组件切换移除，137439983/137439987已撤回，未算通过；修正仅重挂自己的采集后第三次通过，137440701/137440703/137440707已撤回；最终三个消息也均撤回。本轮共九条本人测试消息，无未撤回项。证据为 `tmp/t03-first-live-failure.json`、`tmp/t03-second-live-failure.json`、`tmp/t03-third-live-evidence.json`、`tmp/t03-initial-live-evidence.json` 和 `tmp/t03-protocol-evidence.json`；初始最后一轮证据在运行修复后SDK前另存，不保存正文或凭据，原主工作区材料仅读。

额外 `pnpm exec tsc --noEmit -p tsconfig.eslint.json` 未通过，只剩已记录的 `tests/cdp-client.test.ts`、`tests/driver-connection-lifecycle.test.ts` 的库目标/Buffer诊断及 `tests/inbound-normalization.test.ts` 的数组可空诊断；本轮发送结果、Fake、测试与示例未留新增诊断。LSP references仍初始化退出失败，未把导航记为成功。T03实施验收交付时改动仅留在本工作树，未提交、推送或合并；用户随后另行授权创建详细PR，仍不自动合并或继续T04。

改动文件清单（仅T03及必要调用方迁移）：

- 原生发送与结果：`src/bridge/message-ops.ts`、`src/bridge/renderer-script.ts`、`src/bridge/send-status.ts`、`src/send-operation.ts`、`src/types/index.ts`、`src/index.ts`。
- 必要调用方与旧路径切除：`src/bridge/card-ops.ts`、`src/bridge/image-ops.ts`、`src/dom/send-ops.ts`、`src/driver.ts`、`src/fake-driver.ts`、`src/utils/logger.ts`；未整体删除DOM目录或重做媒体内容协议。
- 新增原生回归：`tests/native-send-receipt.test.ts`、`tests/native-text-sdk.test.ts`、`tests/helpers/native-send-runtime.ts`；原有夹具迁移为 `tests/helpers/renderer-runtime.ts`。
- 既有回归迁移：`tests/bridge-message-ops.test.ts`、`tests/send-ops.test.ts`、`tests/send-operation.test.ts`、`tests/fake-driver.test.ts`、`tests/driver.test.ts`、`tests/driver-health.test.ts`、`tests/driver-lifecycle-logging.test.ts`、`tests/driver-log-sink.test.ts`、`tests/event-bridge-lifecycle.test.ts`、`tests/native-media.test.ts`、`tests/recall.test.ts`、`tests/spike-card-test.test.ts`。
- 专项真机脚本新增 `examples/verify-native-text.ts`；必要示例迁移：`examples/diagnose.ts`、`examples/e2e-real-test.ts`、`examples/e2e-media.ts`、`examples/e2e-stage1-contract.ts`、`examples/spike-card-test.ts`、`examples/verify-native-regressions.ts`。
- 现有说明：`README.md`、`docs/DEVELOPMENT.md`、`docs/KK9-STARTUP.md`、`tasks/todo.md`。本机tmp证据不进入Git，完整保留失败、通过与清理记录。

### PR #2 合并前四项修复

- 业务回执等待：不因四秒外层 IPC 超时提前移除监听，保留请求错误诊断；图片、卡片传入实际业务期限。
- 取消清理：声明前登记整个发送操作，取消覆盖异步 Store、原生身份/草稿准备和语音准备；未提交返回前置失败，已提交无业务证据保持unknown，仅取消本 SDK 的监听。
- 会话绑定：所有发送门面固定调用时目标，复用可变 options 并发发送时，日志、Bot身份登记与快捷撤回仍使用实际原会话。
- 终态保护：Store 原子更新阻止后到 unknown 覆盖 sent/failed及正式ID/业务码/回执；自定义 Store 遵循同一接口约束，未新增字段、迁移或兼容层。

四项均有修复前失败回归。本轮新增18条行为回归，`pnpm check` 的build/typecheck、32个文件381条测试和lint通过；额外测试/示例类型检查仍只报告原有三个测试文件诊断，未记作通过。首次受影响回归发现旧无业务回执用例等待八秒而测试上限五秒，改用假时钟推进业务期限，保留unknown与不伪造回显断言，随后生命周期29条及完整检查通过。

重新执行上列双门禁真机命令，运行ID `0357111b-c8ee-4afd-9a4e-285cd76d9069`；登录与两个既有目标重新核对。私聊正式ID137475067/索引677，群137475321/索引115，私聊提交后断线137475471/索引678；草稿均-26，回执code0、无业务失败、设备33039，断线unknown经共享Store新实例查询为sent。各意图仅一次提交，重复与查询无新增；私聊前后窗口793803，群前后窗口716791。三条本轮消息均撤回，无采集/DriverHook残留、在途0，jshookmcp独立清理后验一致。证据为 `tmp/t03-live-evidence.json`，不覆盖初始PR历史证据。

慢回执、取消竞态、617、普通服务器失败和上传失败没有真实制造，已做协议支撑的确定性回归；未发媒体、改权限、操作同名716827群、全局断网或退出KK9。T04/T05/C2及后续媒体不勾选。用户随后授权提交四项修复、更新并合并PR #2，清理本轮功能分支并更新本地main；不继续后续任务。

## T04 当前实施与验收

公开角色分类和Bot ID登记已删除，方向只比较实际原生UID；已确认本次SDK实时回显带sdkSendKey。先到原生包与先到发送确认按会话+消息ID各派发一次；failed/unknown不添加确认键，仍释放真实本人消息。保留T03业务确认、操作防重和Store终态。普通message/本机业务回调不读Vue普通历史或气泡；仅保留T05本机人工撤回捕获与T11旧窗口轮询。

协议前提由当前jshookmcp/electron_attach与asar_search核对：session-only已读更新没有message；主页面message监听不受聊天组件切换影响；chat-content销毁清空会话sendMsgCallback。SDK只登记自身在途等待与观察函数，不恢复其他监听快照。实际组件缺席、回显竞态、清空回调监听、系统分流与旧连接隔离都有执行生成脚本的行为回归，不标为真机员工消息。

实际自动检查：相关十文件180条通过，补齐日志隐私夹具及异常回执后专项三文件59条通过；最终 `pnpm check` 的build/typecheck、32文件392条和lint通过。首次check有一条日志方向夹具失败，补充发送者UID而非放宽断言后通过。额外 `pnpm exec tsc --noEmit -p tsconfig.eslint.json` 仍只有已有三个文件的库目标、Buffer和数组可空诊断，无新增专项脚本/Fake错误；不宣称全量类型通过。setup成功后复用依赖，LSP初始化退出code0，用全仓调用检索补足。

首轮真机命令：`cmd /c "set KK9_REAL_TEST_CONFIRM=5761:716791:793803&& set KK9_STAGE1_CONFIRM=5761:3585:716791&& set JSHOOKMCP_CACHE=C:/Users/dongshilin/AppData/Local/npm-cache/_npx/54329d0b0943287e&& pnpm exec tsx examples/verify-native-events.ts 5761 0123040139 716791 3585 int2024 793803 29467 测试123"`。运行ID `5a93037a-a7b2-4dbc-be95-5960e5b85268`，原生身份和目标重新核对。私聊137484811/索引681、群137484919/索引117；草稿-26、code0、设备33039，SDK outbound回显及本次意图键均只一次。私聊发送时窗口793803，群发送时716791；实际组件UID6150→6193→6234。历史、重复operationId和只读状态查询无新增提交/事件。

上述两条本人测试消息已撤回并由jshookmcp再次核对C前缀，未撤回他人消息。完成轮退出监听恢复message1/privateCallback1/groupCallback0，采集/DriverHook/原生observer均无残留，在途0。首轮完整元数据为 `tmp/t04-5a93037a-a7b2-4dbc-be95-5960e5b85268.json`；协议与后验为 `tmp/t04-protocol-evidence.json`。后续协助监听使用同脚本 `--listen`，按自己的运行ID单独保留记录，不覆盖首轮证据。

协助轮已用同命令追加 `--listen`，运行ID `e63daa5c-883c-468f-9326-0b6b7c79e495`，服务 `t04-native-listener` 已ready。私聊137487547/索引683、群137487657/索引119，sent、outbound及SDK意图关联均一次；组件UID6300→6325→6368，发送与历史/重复查询仍通过。两条本人文本已撤回，并由jshookmcp独立后验再次确认C前缀。就绪时显示793803、聊天组件UID6393，message3/privateCallback0/groupCallback1、在途0，Driver与独立采集保持运行；后续窗口切换与新入站见下文，不把首轮退出后的零Hook结论套到协助轮。元数据独立保留为 `tmp/t04-e63daa5c-883c-468f-9326-0b6b7c79e495.json`。

服务启动首次PTY仅出现cmd提示符，240秒未就绪；在自己的同一终端发送原双门禁命令后得到实际sent、撤回和就绪。初次等待不记为SDK通过，也没有为未知发送结果重发。终端部分中文日志显示受代码页影响，唯一标记与JSON可读；工具异常已报告，没有修改客户端或共享工具环境。

用户按唯一标记协助发送后，私聊真实新入站137490447/索引685已通过：sender3585/int2024、设备37593，SDK inbound/external一次且无本次SDK发送键；原生message包身份和次数由jshookmcp独立再次核对。收到时显示793803、组件UID6393（基线6300），私聊未显示及实际重建后接收两项同时通过；不撤回他人消息。接收后保持原监听切到716791/组件UID6436，message3/privateCallback1/groupCallback0、在途0，准备授权群新入站；没有重启客户端或重新发送SDK文本。

授权群成员真实新入站137491549/索引121已通过：sender3585/int2024、设备37593，SDK inbound/external一次且无SDK发送键，原生message由jshookmcp独立后验再次核对。收到时实际显示716791、组件UID6436（基线6300），群目标未显示与实际重建后的接收同时通过。重新调用SDK历史后私聊/群新入站仍各一次，两条他人测试文本未撤回。后续观察到实际群窗口793803/组件6469，已通过精确授权切换保持该群，准备本机UID5761人工发送；未重发SDK文本或重启监听。

本机人工群发送137496459/索引122已通过：原生sender5761、设备33039、sendMsgCallback/code0/草稿-26与SDK吻合，SDK outbound一次、origin=unknown且无sdkSendKey；没有把本人手工消息当作SDK确认回显或员工入站。本人group-manual文本已撤回，jshookmcp独立历史核对C1，随后SDK历史读取仍只一条该标记事件。保持原SDK与独立采集切到私聊716791/组件6540，message3/privateCallback1/groupCallback0、在途0，继续等待本机人工私聊；两条sender3585新入站均未撤回。

本机人工私聊137497189/索引686也已通过：sender5761、设备33039、原生sendMsgCallback/code0/草稿-26，SDK outbound一次、origin=unknown且无sdkSendKey。已撤回本人private-manual并由独立jshookmcp正式历史核对C1，SDK查历史后人工私聊/群仍各一次。两条sender3585新入站未撤回。本机人工来源双目标均已完成，现保持原监听显示793803/组件6593、message3/privateCallback0/groupCallback1、在途0，等待另一真实设备UID5761的新私聊和群消息；不控制未授权账号或改变当前登录。

当时没有另一台已登录设备，双目标他设备本人消息未执行；用户现已明确认为无需测试，故从本轮T04验收要求和专项脚本中移除，不再列为缺项或要求提供设备，旧实测报告保留。当前原生session-only累计0；已有onReceiveReadMsg取证要求当前UID且读索引变化，int2024读取不能冒充该真实前提，状态分流仍不记通过。

当前jshookmcp只读核对正常关闭会话会走服务端配置D，用户已明确选择「允许关闭并继续验证」。只点击793803/29467的真实关闭控件，聊天组件6593→无，active=null/Vue实例0/DOM0，message3/两会话回调0、SDK在途0并保持监听；没有退群、清历史、直接改Vue或操作716827。ASAR成员读取因无关完整性块检查失败已报告，当前jshookmcp asar_search取证成功。

同一SDK执行一次absent双目标新意图：私聊137501941/索引688、群137502133/索引124，sender5761/device33039、草稿-26/code0、sent、outbound和对应SDK键各一次。每次前/回执/后均真实组件0、active=null，结束两会话回调0，jshookmcp独立后验一致；无组件SDK回显已实测，不是离线替身。两条本人文本暂保留，等待实际缺席时新入站后再统一清理。

后验曾出现群组件7228，未确认原因；只再次正常关闭同一获准群恢复真实缺席，保留首次SDK结果，不重复absent或重发。截图工具未复用Electron页，一次性截图在组件重现时拒绝正文、再次关闭后CDP截图超时5000ms；Bun依赖解析和批处理参数也失败，未生成图像或安装工具。实际场景以Vue/DOM数量及原生/SDK元数据证明，图像未验收，一次性截图脚本已删除。

无组件群正确标记137507627/索引127已通过：sender3585/device37593，原生message与SDK逐条一致、inbound/external一次、无SDK键，到达时active=null/chats0、两回调0。另保留两条错位标记：137507529/群125为private-absent-inbound；137507597/私聊689为group-absent-inbound。SDK均按实际原生会话收到一次，不是SDK路由错；脚本私聊标记专项仍false，未改标签或削弱断言。后续已按用户要求停止补测并清理，结果见下。

用户确认前两条标记发错后，正确私聊标记137508465/索引690确实收到一次；到达时已有群组件7341，不能计缺席专项通过。此前私聊137507597/索引689在组件0时收到一次，只是携带群标记；这提供私聊无组件接收的真实证据，脚本标记专项仍false，不等于SDK功能失败。重选界面的原因未确认，不归因于SDK或用户。用户明确认为无需继续多轮测试，故停止补测，不再关闭私聊或修改设计。

其他设备本人消息测试已按用户要求取消，不阻塞验收。未验证项保留：真实session-only状态包（累计0）、脚本按正确标记匹配的私聊缺席专项。普通系统通知、提交期间组件销毁和回显两种到达顺序仅有协议与生成脚本回归，不冒充对应真机场景。最终finish已完成：协助轮六条本人测试文本均撤回，含剩余137501941/私聊688及137502133/群124；jshookmcp独立核对原生历史，SDK文本为C:op:、人工文本为C1。他人消息未操作。本轮采集、Driver Hook、发送观察器全部退出，pendingSends=0，emit/send恢复；客户端原有message=1/private=1/group=0监听保留，恢复初始私聊716791。验证程序正常返回cmd提示符，关闭仅本轮服务终端；不再等待补发。

本轮改动文件（不含dist和tmp生成证据）：
- 源码：`src/bridge/converter.ts`、`src/bridge/event-bridge.ts`、`src/bridge/message-ops.ts`、`src/bridge/renderer-script.ts`、`src/dom/message-ops.ts`、`src/driver.ts`、`src/fake-driver.ts`、`src/types/index.ts`。
- 示例：新增 `examples/verify-native-events.ts`；更新 `examples/e2e-stage1-contract.ts` 的本次确认关联，未运行旧全能力发送场景。
- 回归：`tests/bridge-message-ops.test.ts`、`tests/driver-lifecycle-logging.test.ts`、`tests/driver.test.ts`、`tests/event-bridge-lifecycle.test.ts`、`tests/event-bridge.test.ts`、`tests/fake-driver.test.ts`、`tests/inbound-normalization.test.ts`、`tests/logging-privacy.test.ts`、`tests/message-ops.test.ts`、`tests/native-media.test.ts`、`tests/source-classification.test.ts`。
- 说明：`README.md`、`docs/DEVELOPMENT.md`、`docs/KK9-STARTUP.md`、`tasks/plan.md`、`tasks/todo.md`。

`src/index.ts` 的既有类型/规范化导出直接承接新契约，没有旧角色方法导出，故有意不修改或新增兼容层；`send-status.ts` 与T03结果/Store终态边界保留。T05/C2/媒体/T11/T12保持未完成。

## 逐类媒体

每项各自完成自动检查和真机验收，再删除对应旧路径。

- [ ] T06：文件发送；预检、上传失败、实际附件与结果正确。
- [ ] T07：图片；缩略图准备、原图与资源预处理结果正确，接收端可打开。
- [ ] T08：原生富文本、提及与引用；收窄不支持的样式，协议元数据与实际显示一致。
- [ ] T09：链接、业务、应用卡片和合并转发；每种类型分别验收。
- [ ] T10：语音；保留必要AMR能力和音频补丁，接收端实际可播放。
- [ ] C3：以上能力分别有对应测试、`pnpm check`及真实客户端证据，不以文本验收替代媒体。

## 其余原生能力

- [ ] T11a：组织与员工查询；删除DOM回退，空结果与异常正确区分。
- [ ] T11b：指定会话标记已读；原生入口和读索引变化在授权目标验证。
- [ ] T11c：原生历史范围读取；去掉窗口切换轮询与配置，不自动重放新消息。

## 删除旧路径与终验

- [ ] T12a：迁出必要纯数据工具，删除src/dom、选择器、界面自动化、已被完整替代的Vue/DOM挂钩和隐式回退。
- [ ] T12b：收口剩余旧导出、窗口接口、Fake、测试和示例，不留兼容代码；发送状态已在T03、Bot角色模型已在T04按其契约直接删除，不重复实施。
- [ ] T12c：README、开发/启动说明与诊断回归脚本按新契约更新，保留真实操作的身份核对和门禁。
- [ ] C4：完整`pnpm check`通过；保留的能力各有真机验收，连接失效、重复操作、重复事件与未知结果正确，无未完成实现。

## 真机终验前的条件

- [ ] 相应发送、撤回和已读范围明确，门禁核对当前账号与目标。
- [x] T04由int2024与授权群成员分别发送新的入站测试消息，双目标SDK与原生身份一致且各收到一次，目标未显示和组件重建后接收通过。
- [ ] T04双目标本机人工及另一真实设备本人消息、实际组件缺席和状态包前提仍需协助，原监听保持运行。
- [x] T03核实新授权群聊测试123：用户在两个同名原生候选中明确选择793803/29467/nativeType1，群文本真机验收完成；讨论组及管理员撤回仍需另行授权。
- [x] 记录纯原生发送窗口指向不变与聊天组件切换移除监听的客户端差异；不恢复DOM发送掩盖它。未单独声称对端收到/已读或目视聊天正文通过。

本轮核实：登录UID5761，账号0123040139；私聊int2024，UID3585，原生会话716791；群测试123，用户已选择原生会话793803、群接收对象29467、nativeType1。每次运行重新核对身份和两个目标，双确认门禁均保留；不扩大到同名群716827或其他会话。T03完整任务见 [T03-handoff.md](T03-handoff.md)，真实回执与清理结果见 [启动说明](../docs/KK9-STARTUP.md)。
