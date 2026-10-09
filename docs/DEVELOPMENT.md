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

## T05 显式原生撤回

`recallMessage(messageId, session)` 的会话参数必填，只接受原生 ID 或实体，不按名称解析，也不默认当前窗口。撤回从指定会话原生历史取得准确 `msgID/msgIdx`，验证实际登录发送者，仅使用 `type: own`；不再扫描可见消息或猜索引。无效、不存在、已撤回和非本人目标返回 `false`；原生读取/撤回失败抛出 `DriverError(RECALL_FAILED)`，含会话、消息、已知索引、原生方法/错误码与原因。`SendResult.recall()` 绑定本次目标并走相同通知路径。旧 `SendOps.recallMessage` 直接删除，没有兼容别名；其余 DOM 能力不在本轮删除。

SDK 操作成功后进入 Driver 的撤回去重；远端 `message` 中的 `CancelMessage` 独立解析正文目标，不用通知自身 ID。历史查询与 C/D 原记录不重放通知。KK9 原版 `cancelMessage` 本机动作写库并发送系统消息，菜单成功后另发 `${sesUUID}-revokeMsg`；没有已确认的等价本机原生广播，因此保留 Vue 本地通知及组件重建 Hook，不改普通消息或 T04 回显。

回归集中在 `tests/recall.test.ts` 与既有事件/历史/生命周期用例，实际运行生成的原生 RPC 脚本，不再保留旧 DOM 撤回和函数转发自证。Fake 只撤回已注入的指定会话本人消息，修改历史撤回状态并统一去重，不把发送请求自动回显成可撤回历史。真实专项为 `examples/verify-native-recall.ts`，授权范围、门禁、人工动作及结果见启动说明。

本轮 LSP references 再次因初始化退出 code 0 不可用，未反复重启；实际源码、测试和示例调用检索补足。复用工作树已有依赖，没有重复安装或修改锁文件。js-reverse 的相对工具索引与先例文件仍缺失，按当前 jshookmcp schema 取证；安装包与共享工具环境未修改。

实际验证：`pnpm exec vitest run tests/recall.test.ts` 首次复现6项失败，原生切换后7项通过；补充原生业务错误后为8项。八文件受影响回归最初145通过、1项卡片清理失败，定位到仍传界面ID，迁移到已核对原生ID；随后 `pnpm exec vitest run tests/recall.test.ts tests/spike-card-test.test.ts` 的14项通过。首次完整检查测试通过但lint报6处类型诊断，修正后完整检查32文件377项及build/typecheck/lint通过。真实人工撤回暴露验收脚本仅计预备ID的错误，修改 `examples/native-recall-evidence.ts` 与实际脚本并增加一条对应回归后，最终 `pnpm exec vitest run tests/recall.test.ts` 9项、`pnpm check` 32文件378项及build/typecheck/lint通过。仅因失败或后续相关改动重跑，未重跑已知无关的全量测试类型检查。测试数量减少来自删除已被原生切换替代的DOM撤回与mock转发自证，不是弱化失败断言。

`pnpm exec tsx tmp/t05-evidence-smoke.ts` 使用本轮真实采集元数据执行同一修正后的验收函数，双目标三类均通过。新增专项回归验证实际人工新消息不受预备ID限制，旧索引和重复通知不能混入。没有再次发送、撤回或请求用户补发；保留原脚本false及独立最终报告，冒烟脚本执行后删除。真实SDK实现未因该判定修复改变或重启，实际调用与资源退出均来自原持续监听实例。

## T06 原生文件发送

`sendFile(filePath, { targetSessionId, operationId })` 沿用现有原生发送登记。文件来自运行Driver的机器，目录和超过100MB的文件在提交前失败；本地stat/open/read异常保留路径与原错误，返回`failed/isPreTrigger:true`。读取检查只读一个字节，不把整份文件复制进SDK或CDP载荷。检查后文件再被修改或删除，仍由原生上传回执报告，不加锁或自动重试。

KK9原版`sendMessageNew`负责`contentType:3`文件上传并写入`content.uri`，无需SDK再上传一次。上传失败`-9`、业务失败及正式ID关联复用现有`sent/failed/unknown`；外层code0、正ID和文件卡片都不是独立成功证据。重复operationId与`getSendStatus`不再次上传或提交。公开类型、Driver门面、Fake和既有e2e调用契约未变，无需兼容路径；其他媒体不改。

文件错误回归集中在`tests/send-ops.test.ts`，执行SDK生成的原生脚本，覆盖不存在、目录、现有限制超限、实际读取错误、上传-9及617正ID业务失败。删除原有文件code0回声成功断言；正式成功、附件内容和操作防重由`examples/verify-native-file.ts`在授权双目标各发一个小文件合并验收，不能用URL非空代替下载。运行与结果见[启动说明](KK9-STARTUP.md#t06-原生文件专项验证)。

本轮`pnpm exec vitest run tests/send-ops.test.ts -t "文件实际读取失败"`先复现错误判sent；修正后`pnpm exec vitest run tests/send-ops.test.ts`的15项通过。一次最终`pnpm check`通过build/typecheck、32文件380项测试及lint。没有额外重跑T03–T05真机或补测T04，也未重跑已知无关的测试全量类型诊断。

Orca setup终端有安装输出但当前工作树不能解析vitest；确认依赖缺失后仅执行一次`pnpm install --frozen-lockfile`补齐219个包，随后复用，不升级依赖或修改配置。本轮LSP references可用，已核对sendFile实现与Driver调用。js-reverse相对先例/工具索引缺失，使用挂载工具实际schema；asar_search文件过滤失效已报告，唯一函数定位及Electron只读源码成功，未重试已知ASAR完整性失败。

PR #5审计修复：`examples/verify-native-file.ts`的观测Hook不再让损坏的业务`ext`阻断原生事件派发。解析错误保留在本次采集回执的`parseError`字段，原始payload不修改，继续交给SDK/客户端监听；SDK按既有边界返回明确的解析失败`unknown`，不是等待回执超时。没有修改实际文件上传、业务结果契约或增加重试。

对应回归位于`tests/native-send-receipt.test.ts`，直接执行文件专项中的实际采集注入与原生提交脚本。`pnpm exec vitest run tests/native-send-receipt.test.ts -t "文件专项采集"`修复前复现原生回执被阻断、SDK最终超时；修复后`pnpm exec vitest run tests/native-send-receipt.test.ts`的9项通过，确认原始损坏字段仍送达、解析错误可诊断、SDK按既有错误边界结束。本次实现改动后仅执行一次最终`pnpm check`，build/typecheck、32文件381项与lint通过。未重新发送或撤回真机文件，沿用此前双目标附件证据。


## T07 原生图片准备与发送

`sendImage(imagePath, { targetSessionId, operationId })` 保持既有公开契约。图片准备改在KK9的Electron环境内执行：复用其现有`file-type`按文件内容识别格式，以[`nativeImage.createFromBuffer`](https://www.electronjs.org/docs/latest/api/native-image)实际解码和取得尺寸。不可读、损坏、不支持、目录和超过既有20MB限制的图片在提交前返回`failed/isPreTrigger:true`，错误保留源路径和具体原因。不新增图片依赖或扩大未经验证的格式承诺。

缩略图沿用KK9原版最长边300像素、不放大小图、PNG规则，使用`nativeImage.resize/toPNG`，不使用编辑器、DOM或canvas。`sendingImgBeforeHandle`写入缩略图并复制真实源文件，但其catch会吞掉写入/复制错误后仍返回路径；因此SDK实际读取并解码两个生成文件，核对缩略图尺寸/格式及原图尺寸/格式/实际字节数后才提交。原图与base64不跨CDP复制，CDP载荷只携带源路径和发送参数。

原生`sendMessageNew`分别上传`filepath`缩略图和`filepath_h`原图，形成`uri/uri_h`，最终`size`来自原图上传字节数。上传-9、业务失败、正式ID关联、unknown不重发、取消、固定目标及Store终态继续使用已有发送登记和回执；重复operationId与只读查询不再准备或提交。删除图片发送后的Vue/DOM通知，不承诺即时刷新当前聊天气泡。Driver门面、公开类型、Fake及既有图片调用的接口未变化，保持原样，不增兼容路径或重做其他媒体。

图片回归集中于`tests/native-media.test.ts`，执行实际生成脚本，覆盖真实原生解码结果的使用、独立缩略图、损坏/读取/文件限制、缺失或损坏生成文件、原生准备失败、取消、上传及617业务失败、慢回执和unknown防重。Electron边界使用固定真实素材的解码结果替身；不把替身当作真实解码或上传验收。原有图片回声/等待矩阵已被上述具体图片行为替代，其他媒体不改。首次`pnpm exec vitest run tests/native-media.test.ts -t "有PNG头"`复现损坏图片已进入提交、随后因界面依赖返回unknown的错误；修正后的图片准备10项通过，补充准备取消后，受影响三文件共60项通过。

本轮仅一次最终`pnpm check`，build/typecheck、32文件388项测试及lint全部通过。修改后真实SDK双目标各一张640×360测试图，服务器原图和缩略图均重新下载解码、四色采样正确；KK9查看器实际打开双目标原图，用户另行确认接收端两处气泡显示且原图能打开。两条本人图片已撤回，采集及Driver Hook无残留、在途0。命令、尺寸、正式ID和即时气泡刷新边界见[启动说明](KK9-STARTUP.md#t07-原生图片专项验证)。未重跑T03–T06真机或补测T04。

工作树已有依赖直接可用，未再次安装或修改锁文件。LSP references本轮初始化退出code0，未反复重启；结合实际调用路径和受影响回归核对。jshookmcp按实际schema核对KK9图片协议，没有重试旧ASAR完整性失败或修改安装包。辅助浏览器附着不支持Electron的Target.createTarget，改用已有CDP连接采集查看器实际图像；没有为工具失败重发图片。

## 依赖与打包

提交并保留 `pnpm-lock.yaml`、`pnpm-workspace.yaml` 和 `patches`。两条音频依赖补丁属于运行所需配置，升级相关依赖时需重新核对补丁及语音处理行为。

`pnpm pack` 会先构建再生成安装包；本仓库尚未发布 npm 包。pnpm 的补丁设置由消费项目根目录控制，不会因安装此包自动传播。需要把安装包用于其他项目时，在该项目配置对应补丁，并在仅安装生产依赖的环境检查 ESM 导入和实际使用的音频能力。
