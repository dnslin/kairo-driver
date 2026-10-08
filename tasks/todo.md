# 原生 SDK 改造实施清单

状态：T01、T02、C1已完成并随PR #1合并归档，合并提交为1734649；归档见 [archive/T01-T02.md](archive/T01-T02.md)。T03已完成原生文本与公共结果契约切换，通过int2024私聊、用户消歧后的测试123群聊及提交后断线真机验收。T04、T05、C2及后续任务仍未完成，本轮停止在T03。

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
- [ ] T04：原生实时消息与自身回显；方向按当前账号，区分会话状态和历史，正确去重。
- [ ] T05：显式目标撤回；核对SDK主动、远端与客户端手动撤回，不丢本地通知。
- [ ] C2：真实文本双向收发、回显与撤回通过；错误与断线边界有行为回归，`pnpm check`通过。

T03自动验收：相关15个文件、201条行为回归通过；最终 `pnpm check` 的build/typecheck、32个文件363条测试及lint全部通过。删除已被替代的DOM发送、旧success/delivered判别、自动重试与假成功断言，以执行实际生成脚本的原生回执回归替代；保留未切换的撤回、窗口、历史、富文本与媒体内容准备能力。617、普通失败、上传失败码-9、错草稿/错会话、回执先到、超时/提交后断线、重复不提交、查询不提交均有协议支撑的确定性回归。内存中反转617判别条件后，失败断言确实捕获正ID误判成功；未修改源码文件进行变异。

T03真机命令：`cmd /c "set KK9_REAL_TEST_CONFIRM=5761:716791:793803&& set KK9_STAGE1_CONFIRM=5761:3585:716791&& pnpm exec tsx examples/verify-native-text.ts 5761 0123040139 716791 3585 int2024 793803 29467 测试123"`，最终运行ID `388017e3-456a-4312-a989-2860b21a5747`。重新核对登录0123040139/5761、私聊int2024/3585/716791、群测试123/793803/29467/nativeType1；同名群716827/26519未经选择，未发送。私聊正式ID137443977/索引673，群137443981/索引113，提交后断线137443985/索引674；各自草稿-26、回执code0、无业务失败、正式设备33039。断线初始unknown，复用Store创建新Driver后查询sent，未重发。

私聊发送前后窗口均为793803，群均为716791；不读DOM/Vue/编辑器的发送实现在实际另一窗口上完成指定路由。每个意图只有一次原生提交，重复与查询都没有增加第二条消息。三个最终消息均已撤回并核对C/D标记，退出后本轮采集无残留、DriverHook无残留、在途0。617禁发、普通服务器业务失败与上传失败未真机触发；未发送媒体、改权限、管理员撤回、建会话、重启KK9或全局断网。现有撤回仅用于清理，不算T05验收；没有员工新入站，C2不勾选。

保留全部运行清理证据：第一次业务回执包装错误导致unknown，私聊137439705已撤回；第二次群SDK结果sent但专项采集监听被聊天组件切换移除，137439983/137439987已撤回，未算通过；修正仅重挂自己的采集后第三次通过，137440701/137440703/137440707已撤回；最终三个消息也均撤回。本轮共九条本人测试消息，无未撤回项。证据为 `tmp/t03-first-live-failure.json`、`tmp/t03-second-live-failure.json`、`tmp/t03-third-live-evidence.json`、`tmp/t03-live-evidence.json` 和 `tmp/t03-protocol-evidence.json`；不保存正文或凭据，原主工作区材料仅读。

额外 `pnpm exec tsc --noEmit -p tsconfig.eslint.json` 未通过，只剩已记录的 `tests/cdp-client.test.ts`、`tests/driver-connection-lifecycle.test.ts` 的库目标/Buffer诊断及 `tests/inbound-normalization.test.ts` 的数组可空诊断；本轮发送结果、Fake、测试与示例未留新增诊断。LSP references仍初始化退出失败，未把导航记为成功。T03实施验收交付时改动仅留在本工作树，未提交、推送或合并；用户随后另行授权创建详细PR，仍不自动合并或继续T04。

改动文件清单（仅T03及必要调用方迁移）：

- 原生发送与结果：`src/bridge/message-ops.ts`、`src/bridge/renderer-script.ts`、`src/bridge/send-status.ts`、`src/send-operation.ts`、`src/types/index.ts`、`src/index.ts`。
- 必要调用方与旧路径切除：`src/bridge/card-ops.ts`、`src/bridge/image-ops.ts`、`src/dom/send-ops.ts`、`src/driver.ts`、`src/fake-driver.ts`、`src/utils/logger.ts`；未整体删除DOM目录或重做媒体内容协议。
- 新增原生回归：`tests/native-send-receipt.test.ts`、`tests/native-text-sdk.test.ts`、`tests/helpers/native-send-runtime.ts`；原有夹具迁移为 `tests/helpers/renderer-runtime.ts`。
- 既有回归迁移：`tests/bridge-message-ops.test.ts`、`tests/send-ops.test.ts`、`tests/send-operation.test.ts`、`tests/fake-driver.test.ts`、`tests/driver.test.ts`、`tests/driver-health.test.ts`、`tests/driver-lifecycle-logging.test.ts`、`tests/driver-log-sink.test.ts`、`tests/event-bridge-lifecycle.test.ts`、`tests/native-media.test.ts`、`tests/recall.test.ts`、`tests/spike-card-test.test.ts`。
- 专项真机脚本新增 `examples/verify-native-text.ts`；必要示例迁移：`examples/diagnose.ts`、`examples/e2e-real-test.ts`、`examples/e2e-media.ts`、`examples/e2e-stage1-contract.ts`、`examples/spike-card-test.ts`、`examples/verify-native-regressions.ts`。
- 现有说明：`README.md`、`docs/DEVELOPMENT.md`、`docs/KK9-STARTUP.md`、`tasks/todo.md`。本机tmp证据不进入Git，完整保留失败、通过与清理记录。

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
- [ ] T12b：公开导出、Fake、全部测试与示例切换；删除旧状态、Bot角色模型、窗口接口与兼容代码。
- [ ] T12c：README、开发/启动说明与诊断回归脚本按新契约更新，保留真实操作的身份核对和门禁。
- [ ] C4：完整`pnpm check`通过；保留的能力各有真机验收，连接失效、重复操作、重复事件与未知结果正确，无未完成实现。

## 真机终验前的条件

- [ ] 相应发送、撤回和已读范围明确，门禁核对当前账号与目标。
- [ ] T04由int2024发送新的入站测试消息。
- [x] T03核实新授权群聊测试123：用户在两个同名原生候选中明确选择793803/29467/nativeType1，群文本真机验收完成；讨论组及管理员撤回仍需另行授权。
- [x] 记录纯原生发送窗口指向不变与聊天组件切换移除监听的客户端差异；不恢复DOM发送掩盖它。未单独声称对端收到/已读或目视聊天正文通过。

本轮核实：登录UID5761，账号0123040139；私聊int2024，UID3585，原生会话716791；群测试123，用户已选择原生会话793803、群接收对象29467、nativeType1。每次运行重新核对身份和两个目标，双确认门禁均保留；不扩大到同名群716827或其他会话。T03完整任务见 [T03-handoff.md](T03-handoff.md)，真实回执与清理结果见 [启动说明](../docs/KK9-STARTUP.md)。
