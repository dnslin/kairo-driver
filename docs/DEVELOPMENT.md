# 开发与验证

本仓库维护独立的 `@kairo/driver`，源码来自 Kairo 提交 `b25b76b417bf98b56af7310c6b73aebc359e49f7` 的 `packages/driver`。

## 环境与命令

使用 Node.js `>=22.13.0` 和 `package.json` 锁定的 pnpm `11.19.0`。

```bash
pnpm install --frozen-lockfile
pnpm check
```

| 命令              | 作用                                      |
| ----------------- | ----------------------------------------- |
| `pnpm build`      | 编译源码到 `dist`，生成 ESM 和类型声明    |
| `pnpm typecheck`  | 检查 TypeScript 类型                      |
| `pnpm test`       | 运行 `tests` 中的自动测试，不连接真实 KK9 |
| `pnpm test:watch` | 持续运行测试                              |
| `pnpm lint`       | 检查源码、测试和示例                      |
| `pnpm format`     | 格式化源码、测试和示例                    |
| `pnpm check`      | 依次执行构建、类型检查、测试和 lint       |

`src/index.ts` 是公开入口，`src/types/index.ts` 定义接口。`examples` 保留真机诊断和回归脚本，运行方法见 [KK9-STARTUP.md](KK9-STARTUP.md)。

## 修改要求

保持 Driver 的客户端 I/O 边界，应用层的重连监督、持久化和业务处理由调用方负责。对消息方向、原生消息 ID、发送状态、实例失效或去重的修改，应在 `tests` 中补充相应行为回归。

涉及 KK9 实际行为时，还需要在授权测试账号与会话上运行对应真机脚本。自动测试通过只能说明代码层面的验证结果，不能替代客户端收发、附件和断线恢复验收。记录执行命令、通过项和未验证项即可，不复制真实聊天正文或凭据。

T01/T02 的原生读取只读验收使用 `pnpm exec tsx examples/verify-native-readonly.ts <登录UID> <登录账号> <原生会话ID> <对端UID> <对端账号>`。脚本核对真实身份、目标、历史消息ID和索引，检查读索引不变；不执行聊天操作。`getRecentMessages(session, limit)` 必须显式传入原生会话实体，调用方不再先切窗口。自动轮询和补偿扫描的窗口语义仍在后续T11范围，本轮未重做。

历史中的 `C/D` 前缀标记表示原消息已撤回，返回 `isRecalled: true` 并保留原消息类型；撤回系统通知仍保留自身消息 ID。原生历史查询不重放实时事件，现有轮询也跳过已撤回原记录和撤回通知，但保留普通系统通知。当前窗口会话按活动原生 ID 单独查询，不以可见会话列表缺席判断窗口不存在。Driver 的实时与历史方向都使用原生登录身份；身份为空时不沿用配置 UID。

`KK9Session` 的测试实体也必须提供 `nativeType` 和 `receiverId`。`pnpm check` 的源码类型检查不覆盖全部测试；可额外运行 `pnpm exec tsc --noEmit -p tsconfig.eslint.json` 核对测试与示例。该额外检查仍存在既有的 `Promise.withResolvers` 库目标、WebSocket Buffer 类型和测试数组可空诊断，本轮不扩展修复这些无关问题。

T03 文本发送必须指定原生会话 ID，结果为必填 `status` 的 `sent/failed/unknown`，每个结果都有 `operationId`；不再提供旧 `success` 或 `delivered` 判别。发送回归实际运行 SDK 生成的渲染脚本，测试环境没有 document/Vue；只有本次负草稿业务回执与关联正式 ID 才能确认成功。覆盖617正ID反例、普通业务失败、上传失败码-9、错草稿/错会话、回执竞态、超时/提交后失联、只移除自身监听、防重与只读查询。媒体、Fake 与示例只迁移共享结果契约，未进行后续媒体或实时协议改造。

双目标真机验收使用 `examples/verify-native-text.ts`，参数及确认门禁见 [KK9-STARTUP.md](KK9-STARTUP.md)。LSP 本轮 references 仍因 `typescript-language-server exited unexpectedly (code 0)` 不可用；已用实际调用方检索、回归及测试/示例额外类型检查补足，不把失败导航记为成功。

T03 合并前四项修复：业务回执等待不因四秒外层 IPC 超时提前结束，图片/卡片传入实际等待期限；取消登记覆盖 Store 声明和原生准备，异步语音准备结束后不再提交，其他 SDK 监听不受影响；所有发送门面固定调用时目标用于日志、身份登记和快捷撤回；Store 原子更新保留已确认的 sent/failed，不被后到 unknown 降级。自定义 Store 必须执行相同终态约束，接口形状与持久化数据未变化。

本轮新增18条行为回归，四项问题均先用失败回归复现再修复；`pnpm check` 的build/typecheck、32个文件381条测试及lint通过。受影响生命周期回归中，外层请求失败但无业务回执的情况改用假时钟推进实际业务期限，保留 unknown 与无伪造回显断言，不增加真实睡眠或放宽测试超时。额外 `pnpm exec tsc --noEmit -p tsconfig.eslint.json` 仍只报告原有三个文件的库目标、Buffer及可空数组诊断，没有本轮修改文件的新诊断；该额外检查不是通过。

## T04 原生实时事件

T04 使用原生发送者与实际登录 UID 计算方向，公开来源去除业务角色与公共 Bot 消息登记方法。`KK9Message.sdkSendKey` 只关联本次已确认实时回显；Fake 的明确注入也执行方向、会话身份去重和已确认关联，不把发送返回的请求正文自动当作消息。`src/index.ts` 的既有类型与规范化导出继续使用新契约，没有新增旧方法别名。

当前 jshookmcp 核对到：主页面独立订阅 `message`；聊天组件销毁清空本会话 `sendMsgCallback`。事件桥在原生派发边界观察本机普通发送，并登记自身在途回执函数；被客户端移除的 SDK 等待仍可处理本次原生回执，不恢复其他监听快照。退出只释放自身函数与 Hook。Vue 和 MutationObserver 只用于保留本机手工撤回方法的组件生命周期捕获，不读取气泡制造普通消息或历史撤回事件。

自动回归实际执行生成的注入/提交脚本，覆盖无聊天组件/无总线、状态与普通系统分流、回显两种顺序、会话范围去重、失败/未知释放真实本人消息、组件清空监听后成功和异常回执、只清理自身资源及旧连接隔离。原生方向、竞态、清空回执监听与 Fake 关联均有修复前失败记录。新增或切换断言验证行为，不以源码字符串或模拟回声代替。

本轮实际命令：相关十个文件180条回归通过；后续 `pnpm exec vitest run tests/event-bridge-lifecycle.test.ts tests/logging-privacy.test.ts tests/fake-driver.test.ts` 的59条通过。最终 `pnpm check` 的build/typecheck、32个文件392条测试和lint通过。首次完整检查因日志隐私夹具仍只有 `isMe=false` 而失败，补充原生 senderId，保留原 inbound 断言后通过。`pnpm exec tsc --noEmit -p tsconfig.eslint.json` 仍未通过：只报告已有三个测试文件的库目标、Buffer与数组可空诊断，无新专项脚本/Fake诊断，不记作全量类型通过。

Orca setup 的219个依赖安装成功后直接复用，未重复安装或修改依赖/锁文件。当前 LSP references 仍初始化退出code0，已检索全部源码、测试和示例调用；js-reverse 的 field-journal/tool-index 相对路径缺失，改用当前工具真实schema，未修改共享工具环境。真机范围、协议证据和剩余人工前提见 [T04专项验证](KK9-STARTUP.md#t04-原生实时事件专项验证)。T04未完成全部命名真机验收，T05/C2和后续任务不勾选。

按用户要求停止继续补测后，执行现有真机脚本的finish：协助轮六条本人测试文本全部撤回，并用jshookmcp独立核对原生C:op:/C1状态；自有采集、Driver Hook及发送观察器全部退出，pendingSends=0，客户端原监听保留。没有继续关闭私聊、修改实现或重复运行检查。详细证据和未验证项保留在启动说明与tasks/todo.md，T04未冒充全项真机验收。

用户随后取消其他设备本人消息测试：专项脚本移除private-device/group-device标记、初始缺项及专用设备比较，SDK接收实现不变，旧报告不改写。使用既有真机元数据执行实际验收函数，`node tmp/t04-acceptance-smoke.cjs before`复现原设备缺项，`node tmp/t04-acceptance-smoke.cjs after`确认仅移除两项、其余判定逐项不变且全部验收仍false；未连接或操作真机。修改后的`pnpm check`再次通过build/typecheck、32文件392条测试及lint。临时冒烟脚本执行后移除。

## 依赖与打包

提交并保留 `pnpm-lock.yaml`、`pnpm-workspace.yaml` 和 `patches`。两条音频依赖补丁属于运行所需配置，升级相关依赖时需重新核对补丁及语音处理行为。

`pnpm pack` 会先构建再生成安装包；本仓库尚未发布 npm 包。pnpm 的补丁设置由消费项目根目录控制，不会因安装此包自动传播。需要把安装包用于其他项目时，在该项目配置对应补丁，并在仅安装生产依赖的环境检查 ESM 导入和实际使用的音频能力。
