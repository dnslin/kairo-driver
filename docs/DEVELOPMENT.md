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
| `pnpm build`      | 清除旧 `dist` 后编译源码，生成 ESM 和类型声明 |
| `pnpm typecheck`  | 检查 TypeScript 类型                      |
| `pnpm test`       | 运行 `tests` 中的自动测试，不连接真实 KK9 |
| `pnpm test:watch` | 持续运行测试                              |
| `pnpm lint`       | 检查源码、测试和示例                      |
| `pnpm format`     | 格式化源码、测试和示例                    |
| `pnpm check`      | 依次执行构建、类型检查、测试和 lint       |

`src/index.ts` 是公开入口，`src/types/index.ts` 定义接口。`examples` 保留真机诊断和回归脚本，运行方法见 [KK9-STARTUP.md](KK9-STARTUP.md)。

构建先清除自身生成目录，避免已删除的DOM实现残留在产物中。`pnpm verify` 使用包的ESM公开入口而非源码，要求已有本轮构建；仅核对授权身份、双目标有限历史与档案、窗口/读索引/事件不变及监听退出。身份/目标配置见启动说明。

当前附件路径契约以 README 的“跨机器图片与普通文件”及本文末“跨机器附件（未发布）”为准：输入与保存目标属于 Driver 机器，KK9 缓存路径仅由 Driver 在远端解释；下列旧验收中的同机路径描述仍为历史事实。

## 修改要求

保持 Driver 的客户端 I/O 边界，应用层的重连监督、持久化和业务处理由调用方负责。对消息方向、原生消息 ID、发送状态、实例失效或去重的修改，应在 `tests` 中补充相应行为回归。

涉及 KK9 实际行为时，还需要在授权测试账号与会话上运行对应真机脚本。自动测试通过只能说明代码层面的验证结果，不能替代客户端收发、附件和断线恢复验收。记录执行命令、通过项和未验证项即可，不复制真实聊天正文或凭据。

T01/T02 的原生读取只读验收使用 `pnpm exec tsx examples/verify-native-readonly.ts <登录UID> <登录账号> <原生会话ID> <对端UID> <对端账号>`。脚本核对真实身份、目标、历史消息ID和索引，检查读索引不变；不执行聊天操作。`getRecentMessages(session, limit)` 必须显式传入原生会话实体，调用方不再先切窗口。T11已将主动范围读取切到原生分页并删除自动窗口轮询。

历史中的 `C/D` 前缀标记表示原消息已撤回，返回 `isRecalled: true` 并保留原消息类型；撤回系统通知仍保留自身消息 ID。所有历史查询不重放实时事件。T12已删除当前窗口查询与切换接口；单会话查询只接受明确原生ID，不以可见列表缺席判断原生会话不存在。Driver 的实时与历史方向都使用原生登录身份；身份为空时不沿用配置 UID。

`KK9Session` 的测试实体也必须提供 `nativeType` 和 `receiverId`。`pnpm check` 的源码类型检查不覆盖全部测试；额外 `pnpm exec tsc --noEmit -p tsconfig.eslint.json` 仍有既有的 `Promise.withResolvers` 库目标、WebSocket Buffer 类型和测试数组可空诊断。本轮不扩展修复或重复运行这一已知无关检查。

以下T03–T11为历史实施记录，旧路径和当时命令保留事实，不代表当前仍有相应窗口API；当前契约及删除项见README和文末T12记录。

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

PR #6审计补充：新增一条「可解码但尺寸错误的缩略图在创建草稿前失败」回归。预处理边界把真实640×360 PNG原图作为缩略图返回，验证SDK拒绝这一有效但未缩小的产物，保留缩略图路径及具体错误，且不创建草稿。未扩展格式矩阵或修改生产逻辑。

为确认新增回归能捕获审计缺口，临时将缩略图尺寸检查的`||`改为`&&`，执行`pnpm exec vitest run tests/native-media.test.ts -t "可解码但尺寸错误"`，新用例按预期失败（错误结果为sent）。恢复源码并核对与实验前一致后，图片准备专项12项通过；本次唯一一次最终`pnpm check`的build/typecheck、32文件389项测试及lint全部通过。没有真机重发图片，原双目标验收证据继续保留。

## 依赖与打包

提交并保留 `pnpm-lock.yaml`、`pnpm-workspace.yaml` 和 `patches`。两条音频依赖补丁属于运行所需配置，升级相关依赖时需重新核对补丁及语音处理行为。

`pnpm pack` 会先构建再生成安装包；本仓库尚未发布 npm 包。pnpm 的补丁设置由消费项目根目录控制，不会因安装此包自动传播。需要把安装包用于其他项目时，在该项目配置对应补丁，并在仅安装生产依赖的环境检查 ESM 导入和实际使用的音频能力。

## T08 原生富文本、提及与引用

`FormattedText` 直接改为原文字符串或 `{ text, font?: TextFont }`，字体只作用于整条消息；支持粗体、斜体、下划线、pt字号、字体名和六位十六进制颜色。纯数据工具迁至 `src/bridge/rich-text.ts`；删除旧HTML/CSS/Markdown转换、片段样式及相关导出，不保留兼容层。旧HTML/片段输入、删除线/高亮及无效颜色在提交前返回failed，不静默剥标签或推广某段样式。字符串中的HTML/Markdown按原文字面发送，换行及反斜杠不改变；CLI转义只留在诊断示例。

提及须为真实UID与显示名，任意昵称字符串不再转成UID0。显式all保留原版-1节点，不在T08真机发送。引用只接受原生消息ID及可选准确索引，指定会话原生历史取得真实作者和内容；索引不符、跨会话、不存在、已撤回、缺少作者/索引或查询错误不能构造假引用。历史错误保留原生方法/码及会话/消息上下文，不吞为未找到。

普通提及按原版`atState=0/atMemberIDList`发送；引用按原版`atState=2`，列表包含引用作者和正文提及UID。引用字体位于顶层`content.font`，正文在`replyContent.content`。规范化解析真实引用正文与作者UID/索引，也解析正式历史中JSON字符串形式的UID列表；不能仅凭atState=2把任何引用标为@当前用户。Fake复用输入准备边界，引用仅查指定会话注入历史，不由发送请求制造消息。

七条具体T08协议/边界回归位于`tests/rich-text.test.ts`，实际执行SDK生成的提交及历史脚本；旧HTML/CSS转换测试删除，不以源码字符串、快照或mock回声替代协议行为。其他受影响Fake、操作登记、调用示例和引用断言同步迁移。没有新增依赖、编辑器/格式框架、兼容层或其他媒体改造。

本轮LSP references仍初始化退出code0，未反复启动，实际调用检索补足。jshookmcp包内搜索成功，浏览器附着超时后使用现有CdpClient在KK9内只读核对原版序列化与渲染字段；未重试旧ASAR完整性失败、修改安装包或共享工具。依赖可直接解析并复用，未手动重新安装或升级。

本轮命令与结果：`pnpm exec vitest run tests/rich-text.test.ts`先复现六项协议/契约失败；修正后仅剩历史测试调用缺少会话上下文，改用真实`getRecentMessages`边界。六文件受影响回归88通过、1项旧`content.type=Reply`内部字段断言失败，原版发送前已删除该字段，移除过时断言后`pnpm exec vitest run tests/send-ops.test.ts -t "引用只按"`通过。首次`pnpm check`的build/typecheck、32文件374项与lint通过。真机脚本随后修正“正式历史等于提交提及字段”的错误断言，因此再执行一次最终`pnpm check`，同样全部通过；此后只更新记录，不重复检查。

修改后的真实SDK完成授权双目标格式/引用/普通提及/引用提及，用户明确选择「全部展示与两次通知正确」。最终运行`34ba687a-6fa5-43aa-9749-39dc00296e6c`；正式ID、消息级font、引用准确目标、提交/业务回执/正式历史元数据及清理见启动说明与`tmp/t08-live-evidence.json`。发送方正式历史已将atState归一为1，私聊列表为空、群列表仅3585；真实提交和业务回执仍为普通提及0/[3585]、引用提及2/[5761,3585]。不得用发送方历史重造通知或把sent当接收端展示证据。

首轮两条及最终四条本人消息全部撤回，采集/Driver Hook无残留、在途0。未真机制造错误会话、历史故障、业务失败，也未扩展字体矩阵、@全体或其他成员；相应协议边界由必要回归/原版字段支撑，不把未操作范围写成真机通过。不重跑T03–T07专项、T04补测或已知无关测试全量类型检查；未提交、推送、开PR、合并或继续后续任务。

### PR #7 审计修复

引用查询按原生`contentType`区分内容：`Text(0)`保留字符串原文，其他结构化消息继续解析JSON并校验对象。修复原生纯文本历史能读取却无法引用的问题，保留真实作者、消息ID、索引、原生内容类型和换行；不是恢复HTML兼容或增加内容猜测。Fake本来接受同一条已注入的纯文本历史，本次真实生成脚本修正后与其一致，无需再改Fake。

新增一条纯文本引用回归；现有错误索引用例改为`ID88/索引7`与同会话真实`ID89/索引8`，请求`ID88/索引8`必须在提交前失败。临时移除精确索引查询中的ID匹配，执行`pnpm exec vitest run tests/rich-text.test.ts -t "其他会话同号"`，加强后的用例按预期失败（错误地返回sent）；随后恢复正确匹配，没有保留变异。

`pnpm exec tsx tmp/t08-review-fix-smoke.ts`实际执行SDK生成的引用查询/提交脚本：原生纯文本引用sent，作者91002、ID88/索引7及字符串正文正确；索引指向另一消息时failed/isPreTrigger:true且无新增草稿。冒烟脚本已删除。这是原生IPC边界替身的协议验证，不冒充服务器或接收端真机；本次未重发真机消息，原有格式/两种提及/接收端确认继续保留，原生Text(0)新分支未另作真机发送验收。

本次修复后仅执行一次最终`pnpm check`：build/typecheck、32文件375项测试及lint全部通过，其中富文本专项7项通过。没有重复原生发送真机验收或前序专项；最终检查后只补充记录与PR说明。


## T09 原生卡片与合并转发

四类卡片复用既有结构化提交、负草稿业务回执、操作登记及Store终态。删除卡片发送后的DOM/Vue摘要更新与气泡通知；只有尚未切换的语音分支保留原通知，语音准备、取消和发送协议不变，不实施T10。

合并输入改为`{ sourceSessionId, msgArray: [{ messageId, msgIdx }] }`。指定来源会话原生查询必须同时匹配ID、索引、会话；正文、UID、显示名和时间从真实未撤回记录取得，按原索引排序。不再接受任意简报正文/标题，删除序号ID、UID0、未知作者和发送时间填补。Text纯文本转换为原生PicText节点供预览与详情消费，保留真实原消息身份。Fake只认可指定会话已注入的准确来源，不从发送请求制造历史。

业务参数显式要求原生`bizType: 1 | 2`与相对`ekp_outer_domain`的`bizUrl`，不把外部完整网址拼接到业务域名后，也不默认创建假业务类型。应用普通通知不需要pcAppCode；源码/原生getApps已查证，测试没有猜编号。链接不伪造isValid或本地图片路径；本轮使用原版默认图标。没有新增依赖、插件框架、兼容路径或其他媒体改造。

必要回归在`tests/native-media.test.ts`，直接执行SDK生成脚本，验证链接/应用原生字段、业务路径错误、准确合并正文/顺序/两名真实作者、错误索引与UID0拒绝、617正ID失败。删除旧五类回声、合并快照自证和已被替代的卡片界面通知测试；原共享语音回归继续运行。诊断脚本只接受明确载荷并复用BridgeMessageOps，旧同名群名片示例删除；e2e合并来源改为该轮已发送记录。

修改后真实SDK四类各一次发送，私聊716791覆盖链接/应用，既定群793803覆盖业务/合并；四类正式记录、真实展示、合并点击详情及子条目作者UID5761已核对，四条本人卡片全部撤回，采集与Driver Hook无残留、在途0。原版合并预览直接显示应用HTML标签，详情正常渲染；保留差异，不改即时气泡刷新。另一台接收设备、点击后的远端业务页面及其他媒体转发未实测。命令、正式ID、截图和工具限制见启动说明T09节。

本轮LSP references初始化退出code0，未重启；按全部实际源码/测试/示例调用检索迁移。依赖已可解析，直接复用，不重新安装或升级。jshookmcp包内定位与客户端只读取证可用；附着和截图辅助问题没有导致重发，原主工作区未修改。

必要命令与结果：`pnpm exec vitest run tests/native-media.test.ts -t "链接和应用通知|业务通知必须|合并从来源|合并索引|卡片原生617"`的5项具体协议行为通过；迁移后的四文件受影响回归52项通过。首轮受影响回归51通过、1项仍要求卡片Vue通知的过时测试失败，按原生切换删除该测试，没有改成新实现自证。

最终`pnpm check`通过build/typecheck、32文件373项测试与lint。前两次完整检查分别因`getCardInputError`缺少显式undefined返回、诊断脚本finally中的throw被lint拒绝而失败，修正后才重跑；最后一次通过后不再运行检查。测试数量下降来自删除旧回声/快照和已替代界面测试，同时补入准确索引、真实作者和业务失败断言。没有额外全量测试类型检查、前序真机专项或T04补测。

真实SDK最终运行`fe90b0bf-5092-489a-8fbe-2259cd5f4c47`的四条本人卡片全部撤回并确认C/D，观察进程exit0，采集残留false、DriverHook残留false、在途0。一次性启动、取证、定位与截图脚本已删除，辅助浏览器会话已关闭；独立历史窗口退出时已不在CDP目标中，没有重开或操作其他窗口。保留必要协议/正式ID/展示元数据及本轮卡片区域截图。未提交、推送、开PR、合并或继续后续任务。

### PR #8 审计修复

合并引用回复前使用原生`getMessageByMsgId`查询引用目标；目标带`C/D/E`前缀时，将内嵌引用替换为原生PicText“消息已被撤回”，保留回复正文。查询失败保留方法、目标ID和错误码，在创建草稿前失败，不继续转发旧引用正文。私聊来源的`typeID`指向本人时，合并标题的对端名取`createrName`，与既有`source.receiver`选择一致；其他来源继续使用原名称，不改共享会话模型。

新增三条具体回归：撤回引用与正常引用的区分、引用目标查询失败不提交、对端创建私聊的标题。`pnpm exec vitest run tests/native-media.test.ts -t "合并引用|对端创建私聊"`修复前3项失败，修复后3项通过。最终仅运行一次`pnpm check`，build/typecheck、32文件376项测试与lint全部通过。

真实SDK完成本轮原文、回复、撤回原文及群合并，正式记录与原版详情均确认撤回占位、回复正文保留及对端名正确；三条本人消息已撤回，Driver Hook无残留、在途0。现有授权私聊由本人创建，对端创建的反向分支只由回归覆盖；没有伪造原生会话或修改数据库。详细证据及截图限制见启动说明PR #8小节。公开类型、Fake记录契约、调用方和示例无需变化；没有提交、推送或合并。


## T10 原生语音准备与发送

继续复用现有MP3/WAV解码、混为单声道、8kHz重采样、KK9内置AMR-NB编码及Edge TTS。保留`pnpm-workspace.yaml`、`@audio/decode-wav@1.5.0`与`node-edge-tts@1.2.10`两条补丁，依赖已可解析，未重新安装或升级。KK9编码器严格小于帧边界，现有额外补帧保留；时长来自回解采样数向上取整到秒，不用输入文件大小或假时长。

准备结果只包含`duration/data`：`data`是随消息内联传输的AMR Base64，不走文件上传；原版收到正式消息后调用`amrnb.toWAV`写入`<正式ID>.wav`，其`filepath`供播放。移除准备结果中的原始WAV/MP3路径，避免把输入文件误当正式播放资源。删除共享结构化提交中最后的语音document/Vue通知，不整体删除DOM或改撤回捕获，不修即时气泡刷新。

公开`KK9VoiceOptions`、Driver门面、Fake与`e2e-media.ts`输入契约不变，无需兼容层或调用迁移。T10使用独立`examples/verify-native-voice.ts`，不运行包含卡片的全能力e2e；固定授权身份、两目标和双确认门禁，真实TTS与自建WAV各一条。合并核对负草稿业务回执、正式ID/资源/时长、防重与只读查询；接收端播放单独确认，资源回解不能替代听感。

两项现有回归先复现错误：原始路径误入准备内容、无document环境在正式业务成功后返回unknown。修正后`pnpm exec vitest run tests/voice-ops.test.ts tests/node-edge-tts-boundary.test.ts tests/native-media.test.ts -t "prepareVoice|node-edge-tts|语音"`通过32项（14项未选中），覆盖既有输入/解码/编码/合成失败、取消、固定目标与防重，不增加源码字符串、快照或回声测试。LSP references初始化退出code0，未重启，已按实际源码/测试/示例调用检索核对。真机结果见启动说明T10节。

本轮唯一一次最终`pnpm check`通过build/typecheck、32文件376项测试及lint；之后仅更新Markdown记录，没有重复检查。修改后的真实SDK双目标各一条，用户一次明确确认“两条播放及结尾均正常”；正式记录、时长、确认与清理见启动说明T10节。未真机制造编码器故障、上传-9或服务器业务失败，未运行前序专项或已知无关测试全量类型检查。

### 文本 TTS 进程代理（按需工具配套修复）

文本合成向 SDK 已有 `proxy` 选项显式传入 Driver 所在 Node 进程的非空 `HTTPS_PROXY`（优先）或 `HTTP_PROXY`，先 trim；均未设置维持既有直连。指定代理失败保留 `VOICE_TTS_FAILED` 及原始原因，不换代理或回退直连。不读取 Windows 注册表、AstrBot 代理或 `ALL_PROXY`，不增加公开参数、KK 配置或依赖。

`pnpm exec vitest run tests/voice-ops.test.ts tests/node-edge-tts-boundary.test.ts` 17 项通过；随后 `pnpm check` 的构建、类型检查、33 文件 409 项测试及 lint 通过。新增 5 项代理选路/失败回归使用真实本地 HTTP CONNECT 拒绝服务，并在 TCP/TLS 边界阻止外网访问；验证优先级、空白处理、失败原因及不再直连，不把构造参数回声当验收。删除旧测试中 SDK 构造选项的内部复制断言，保留音频转换、临时文件清理及输入错误行为验证。

真实运行先观察到直连 Edge 403；给 SDK 显式代理后合成及 KK AMR 编码/回解通过。修改后使用正常 Driver 编译产物、仅设置标准 `HTTPS_PROXY` 再运行独立 `prepareVoice({text})`，得到 3534 字节、4 秒 AMR，965 毫秒完成。只建立独立 CDP 连接，未调用 Driver.connect 接管 Hook、未发送消息或调用模型；这证明合成及编码，不是接收端播放验收。未修改生产环境变量或重启已有进程。


## T11a 原生组织与员工查询

组织遍历从 `getDepartmentVisible` 的真实可见根开始，复用 `getChildDeptsAndMembers` 每页200成员、部门遍历与UID去重。正常空组织返回 `[]`，档案 `getMemberDetail` 正常缺席返回 `null`；原生错误、期限耗尽、部门上限或无效页抛出带方法/部门/页/原因的 `DriverError`，不返回部分全量。移除DOM/Vue身份发现、Vuex补集、Driver回退及旧 `OrgOps` 导出/实现，纯解析工具仍保留。

实际回归：`pnpm exec vitest run tests/bridge-org-ops.test.ts tests/driver.test.ts -t "原生组织与员工查询|原生正常空组织|getEmployeeBySession"`，8项通过。组织专项先复现4项失败；修正后发现并补回部门路径。LSP references初始化退出code0，未重启，已检索实际调用补足。真机命令和结果见启动说明；最终完整检查等待三切片完成后只运行一次。

## T11b 指定原生会话已读

`markSessionRead` 仅接受原生会话ID，先 `getSessionBySessionID` 取得真实类型和 `maxMessageIndex`，再调用 `readMessage`；不按名称或当前窗口选目标，不猜索引、不改Vue/总线。不存在返回false，原生失败抛带会话/方法/码/原因的DriverError。删除旧DOM视觉已读方法及旧回归，Fake按明确会话更新未读状态。

实际命令：`pnpm exec vitest run tests/bridge-session-ops.test.ts tests/driver.test.ts tests/fake-driver.test.ts -t "指定原生会话已读|已读名称|会话管理与组织|历史查询返回历史撤回"`，6项通过；专项先复现2项失败。真机双目标真实未读推进、已读幂等与历史只读已验收，详见启动说明；不重复前序真机或逐片全量check。

## T11c 主动历史范围读取与轮询删除

复用 `getMessages`、历史规范化与原生会话映射，以 `endIdx` 每页200条向前读取并筛选时间闭区间，保留每会话最近N条、原生身份和会话范围去重。达到数量、原生短页或索引终点即结束；消息时间不保证与索引同序，不以时间下界提前停止。默认N为20，不把原生短页或数量上限冒充无限全量。原生底层按 `msgIdx <= endIdx` 倒序查询再反转，并应用会话 `showIndex`；资源/历史缓存可能由KK9内部更新，但SDK不切窗口、不改读索引、不派发历史事件。页失败及无法推进索引抛带会话/endIdx/原因的DriverError。

删除 `startPolling/stopPolling`、`PollingConfig`、`DriverConfig.polling`、`switchDelayMs`、窗口计时循环、历史事件重放方法和所有调用；Fake实现相同主动范围筛选，不增加调度器、缓存、数据库、重试或兼容层。诊断/阶段示例改为既有实时监听；旧回归脚本只做主动历史读取。删除失效轮询回声/计时器/日志测试，保留真实事件、历史不重放与连接生命周期回归。

实际定点命令：`pnpm exec vitest run tests/compensation-scan.test.ts tests/bridge-message-ops.test.ts tests/driver.test.ts tests/inbound-normalization.test.ts tests/logging-privacy.test.ts`，69项通过；四项范围回归先复现窗口依赖、边界与Fake空占位失败。真机 `pnpm exec tsx examples/verify-native-queries.ts c` 已核对跨页老范围、数量上限与双目标只读，详见启动说明。三切片最后统一运行一次 `pnpm check`。

### T11 最终检查与边界

最终 `pnpm check` 通过build、typecheck、33文件367项测试及lint。首次统一检查build/typecheck及全部测试通过，仅报专项脚本多余类型断言与Fake范围方法require-await；移除多余断言、Fake显式返回成功/拒绝Promise后，因该失败重跑一次通过。此后只更新Markdown，不重复检查。未运行已知无关的额外测试全量类型检查、T03–T10真机专项或T04补测。

当前包未发布，仓内受影响调用全部直接迁移，删除项无兼容别名；不新增依赖、组织缓存、数据库、查询框架、自动轮询替代品或恢复监督。LSP本轮初始化退出code0，以真实调用检索补足；js-reverse相对先例/工具索引缺失，使用已挂载jshookmcp真实schema。ASAR搜索fileGlob失效已报告，改为既有CdpClient只读读取当前主进程相关源码，未重试整包完整性失败或修改安装包/共享工具。

一次性协议脚本已删除，Driver/核对连接及监听终端已退出，独立后验Hook残留false、在途0；仅保留必要元数据说明与可复用专项脚本。原生故障由必要回归覆盖，删除/隐藏前的不可见历史未实测，不把有限范围称为全量。未实施C2/C3/T12，未提交、推送、开PR或合并。

### T11 PR 审计问题修复

- 历史范围读取删除按时间下界提前停止的条件，避免索引与时间不同序时漏掉后页。回归使用201条记录、一次两秒时间倒序，修复前漏掉索引1，修复后返回范围内全部200条。
- 指定档案查询对数值零及零填充字符串返回 `null`，在IPC之前阻止原生 `getMemberDetail` 把零值替换为当前登录UID；不改变其他档案查询或原生失败处理。
- Fake标记当前会话已读时，同步当前会话副本的 `unread/unreadCount/unreadAt`，保持当前会话ID和激活状态；非当前目标沿用既有行为。

三项各补一项行为回归，均先失败后通过。定点命令：`pnpm exec vitest run tests/compensation-scan.test.ts`（5项）、`pnpm exec vitest run tests/bridge-org-ops.test.ts`（5项）、`pnpm exec vitest run tests/fake-driver.test.ts -t "标记当前会话已读|会话管理与组织"`（2项）。另以 `pnpm exec tsx -e` 实际调用Fake选择、标已读及两个读取接口，核对列表/当前会话均为已读、计数0、无未读提及，当前会话保持激活。

修改后的 `pnpm exec tsx examples/verify-native-queries.ts c` 已核对授权身份、零UID返回值和双目标原生历史对照，窗口、读索引及事件计数不变，详见启动说明。没有在真机制造时间倒序，该边界由固定数据回归覆盖。本轮只运行一次最终 `pnpm check`，build/typecheck、33文件370项测试及lint全部通过；之后仅更新Markdown说明。未添加依赖、兼容层或其他机制，未提交或推送。

## T12 清理记录

T12a：员工解析迁至 `src/utils/employee.ts`，图片读取与另存迁至 `src/utils/image.ts`，保留公开工具名称。删除 `src/dom`、选择器实现及旧DOM服务导出、Driver后备服务、DomError和已移除界面功能的测试。原生媒体、AMR及两条依赖补丁未改；本机菜单撤回的已验收Vue本地通知与组件重建监听保留，不声称无任何Vue/DOM依赖。

实际命令：`pnpm exec vitest run tests/org-parser.test.ts tests/message-ops.test.ts tests/bridge-org-ops.test.ts`，3文件16项通过。没有新增永久测试；图片工具原有断言改为核对完整Data URL与复制字节，原生员工与零UID边界沿用既有行为回归。LSP references初始化退出code0，未反复启动，改用全部实际调用检索补足。

T12b：直接删除 `getCurrentSession/selectSession`、`KK9Session.active`、`SelectorsConfig/DriverConfig.selectors`、`PreSendCheckResult`及Fake的窗口副本、界面预检设置/计数。Driver、Bridge、Fake、全部现行示例与测试同步收口；原生单会话读取的有价值回归改用已有 `getSessionById`，不保留窗口接口别名。发送结果、主动历史范围、失效隔离与去重实现未改。

实际命令：`pnpm exec vitest run tests/bridge-session-ops.test.ts tests/driver.test.ts tests/fake-driver.test.ts tests/compensation-scan.test.ts`，4文件45项通过。脚本仅独立观察窗口，显示/人工菜单场景由操作者在KK9内打开明确授权目标；不再由SDK准备或恢复界面。历史归档中的旧窗口操作保留为当时事实，不代表当前接口。

T12c：删除三条过时的Vue/组件历史专用诊断，保留并迁移全部原生收发、资源、撤回、范围读取脚本。`pnpm diagnose help` 实际运行通过，不再包含switch。`pnpm verify`改从构建后包入口导入，并核对授权双目标历史、身份/档案、窗口与读索引不变、历史不重放及自身资源退出。build仅清除本工作树生成的dist再编译，旧DOM产物不进入包；没有pack、发布、依赖升级或手动重复安装。

最终 `pnpm check` 通过build/typecheck、30文件336项测试及lint。首轮build/typecheck/336项已通过，仅lint报告删除界面预检后两条残留导入；删除这两条未使用导入后因该失败重跑一次通过。测试减少来自删除已移除窗口/DOM功能和mock回声，不是删除失败断言；未增加测试数量、未重跑T01–T11真机专项、媒体矩阵或T04补测，也未运行已知无关的测试全量类型检查。最终通过后仅更新Markdown记录，不重复检查。

改动后真实 `pnpm verify` 通过，使用本轮清空dist后生成的 `@kairo/driver` ESM入口；登录、双目标、每目标3条ID/索引原生对照及必要档案一致，窗口511315与读索引724/153不变，实时事件0。退出后message监听仍1，自身Hook/发送观察器false、在途0，两个CDP连接disconnected且进程exit0。完整命令与元数据见启动说明T12节。

保留边界：`event-bridge.ts` 未修改，仍有Vue总线、会话通知、`addRevokeMsg`、组件发现/重建监听及撤回显示名读取；它们仅服务原已验收本机菜单撤回，未作为发送或原生历史的数据源。没有已确认且经真机证明等价的无Vue本机菜单通知，本轮不尝试全局拦截或改安装包来替代。复用T05三类撤回、T03/T04实时与unknown、T06–T10媒体、T11范围/已读既有证据，不把这些旧结果称为本轮重测。T12a可达清理已交付，但彻底去除此必要依赖的条件未满足，因此T12a和C4保持未勾选；T12b/T12c完成，C2/C3与T04既有状态不变。未提交、推送、开PR、合并或发布。

## C3 逐类媒体证据收口

本轮核对现行 `BridgeMessageOps`、图片/卡片/富文本/语音准备及既有行为回归，复用已合并的T06–T10实际记录。T12仅迁移纯数据工具并删除旧窗口路径，未改变这些媒体协议；未发现使逐类证据失效的改动或具体缺项，C3完成。不重新发送媒体、不重复TTS或试听、不新增测试；下表完整检查均为对应历史阶段的最终结果，不是本轮重跑。

| 能力与证据 | 现行路径及行为回归 | 复用的真实客户端证据 | 历史最终完整检查 |
| --- | --- | --- | --- |
| [T06 文件](../tasks/archive/T06.md) | `message-ops.ts`；`send-ops.test.ts`、`native-send-receipt.test.ts`：本地读取失败、上传/617业务失败、防重及损坏回执不阻断派发 | 双目标各73字节附件，服务器无缓存重下载并逐字节一致，已撤回并退出自身资源 | build/typecheck/lint及32文件381项通过 |
| [T07 图片](../tasks/archive/T07.md) | `image-ops.ts`；`native-media.test.ts`：真实尺寸/格式使用、独立缩略图、损坏/错误尺寸产物拒绝、取消与防重 | 双目标原图/缩略图重新下载解码，KK9查看器及接收端显示/打开确认，已清理 | build/typecheck/lint及32文件389项通过 |
| [T08 富文本/提及/引用](../tasks/archive/T08.md) | `rich-text.ts`、`message-ops.ts`；`rich-text.test.ts`：整条font、真实UID、准确引用ID/索引及Text(0)原文 | 私聊格式/引用、群普通/引用提及，用户确认全部展示与两次通知正确，六条本人消息已清理 | build/typecheck/lint及32文件375项通过 |
| [T09 四类卡片/合并](../tasks/archive/T09.md) | `card-ops.ts`；`native-media.test.ts`：原生字段、业务路径、准确来源/作者、撤回引用占位、反向私聊标题、617拒绝 | 链接/业务/应用/合并逐类呈现与合并详情；审计修复另有撤回占位真机，全部本人消息已清理 | build/typecheck/lint及32文件376项通过 |
| [T10 语音](../tasks/archive/T10.md) | `voice-ops.ts`及结构化提交；`voice-ops.test.ts`、`node-edge-tts-boundary.test.ts`、`native-media.test.ts`：编码/输入错误、清理、取消与防重 | 真实Edge TTS与本地WAV分布双目标，AMR/正式播放资源核对，用户确认两条播放及结尾正常，已清理 | build/typecheck/lint及32文件376项通过 |

未实测边界不扩大：T06未证明另一接收设备人工打开；T07不承诺当前聊天气泡即时刷新；T08审计新增Text(0)引用分支只有协议回归、未另作真机发送；T09反向私聊标题只有行为回归，另一设备及远端业务站点未实测，合并预览保留原版HTML标签差异；T10未真机制造编码器或服务器故障，必要AMR及两条音频补丁保留。旧tmp不随Git，本轮依据已合并归档与开发/启动记录，不声称重新读取旧原始文件，也不把历史发送/展示/播放称为本轮实测。

## C4 现行契约与最终验收

本轮只核对并记录，不修改生产代码、公开类型、Fake、测试、依赖或门禁。`src/index.ts`和`package.json`仅提供现行包入口；`IKK9Driver`、Driver与Bridge均无旧窗口/active/选择器/预检/后台轮询接口或DOM回退，纯员工/图片工具和音频补丁保留。原生会话ID、接收对象UID与消息ID/索引各自明确，`SendResult`为必填`status/operationId`，sent不代表对端收到或已读。

核对的现行行为及既有回归：

- 连接失效报告原始cause和连接身份，旧事件不进入新连接，旧实例退出不破坏新Hook；见`driver-health.test.ts`、`driver-connection-lifecycle.test.ts`、`event-bridge-lifecycle.test.ts`。
- 同一operationId先声明再提交，指纹冲突拒绝；重复意图与unknown只返回/查询既有业务证据，不重发，后到unknown不覆盖sent/failed；见`native-text-sdk.test.ts`、`native-send-receipt.test.ts`及`send-operation.test.ts`。真实提交后断线查询复用[T03记录](../tasks/archive/T03-T04.md)，不制造新断线或消息。
- message/at共用会话＋消息ID去重，recalled按会话＋撤回目标去重，不把通知自身ID当目标；历史返回不进入实时派发，不切窗口或标已读。见`event-bridge.test.ts`、`event-bridge-lifecycle.test.ts`、`recall.test.ts`及`compensation-scan.test.ts`；三类撤回复用[T05](../tasks/archive/T05.md)，组织/已读/历史范围复用[T11](../tasks/archive/T11.md)，媒体证据见上节。
- 退出只移除自身订阅、binding、观察器及在途等待，保留客户端和其他实例监听；生成脚本回归与本轮构建入口烟测分别证明边界行为和真实退出，不互相冒充。

保留必要本机菜单Vue总线/会话通知、`addRevokeMsg`及组件重建监听；不宣传无任何Vue/DOM依赖，不承诺即时聊天气泡刷新。T04真实状态包和正确标签私聊缺席专项未全部实测的事实不改，停止补测及取消其他设备本人测试的决定继续有效。当前T12和真机前置条件按用户手动勾选保留，C2不变；旧T12段落的未勾选描述仅为历史，不成为本轮新增前置。

本轮最终仅运行一次`pnpm check`，build/typecheck、30文件336项及lint全部通过；随后复用该次干净构建的`dist`执行现有`pnpm verify`，授权身份、双目标每目标3条历史原生对照、档案/私聊映射、窗口/读索引/实时事件及自身资源退出全部通过。实际命令与元数据见[本轮启动记录](KK9-STARTUP.md#c4-最终构建入口只读验收)。未另跑build/pack、媒体矩阵、TTS/试听、前序真机专项或已知无关的额外类型检查。仅本次完整检查与只读烟测为本轮实测，其余真机能力复用上述已合并证据；C3/C4完成不表示全原生，也不改写T04/C2状态。

## 按工号首次联系与文本通知

在 `feature/send-text-to-user` 增加 `sendTextToUser(loginName, text, SendToUserOptions)`。规划与任务见 `tasks/plan.md`、`tasks/todo.md`。工号定位采用真机可用的 `unionSearch(type:user)` 分页后精确匹配，读取目标档案并执行原生私聊权限检查。`getUsersByLoginNames` 的内部错误及 `getSessionInfo6` 的610没有被当作成功或增加静默回退；可见组织缺席不等于人员不存在。

工号发送统一使用KK9原版 `receiver:UID/sessionType:0/sessionID:0`，由服务端解析或建立私聊。新增发送类型 `text-to-user`、指纹 `targetLoginName` 和结果/记录 `sessionId`；自定义Store需保存这些字段并比较准确工号，没有发布包或已确认的旧数据迁移要求。业务回执必须绑定本次负草稿和双方UID，正式历史与回执会话/消息一致后才确认；状态恢复同样只读这些证据，不重新找人或提交。Driver快捷撤回绑定正式会话。原按会话和媒体接口不变。

事件桥的首次在途发送仅暂存同意图标记、实际本人、准确接收对象和私聊类型匹配的原生回显；正式确认后使用真实会话行派发一次 `sdkSendKey` 关联。Fake复用原有Store/故障行为，只在成功时建立或复用模拟私聊，不制造历史或实时回声。本人设备发送会被KK9改写消息标记为AA1，明确不在新接口范围内。

实际验证：首轮新增协议/事件回归运行时25项失败、原有40项通过，随后完成实现。反向私聊字符串UID另以失败回归复现unknown后修正。六文件受影响回归153项通过。审查时暂时移除回执接收对象匹配，错收件人回归按预期捕获错误sent；恢复条件后唯一一次最终 `pnpm check` 通过build/typecheck、31文件381项测试和lint。没有弱化断言、忽略错误、升级依赖或重跑已知无关的额外测试类型检查。

复用该构建从 `@kairo/driver` ESM入口运行 `examples/verify-native-user-text.ts`：授权5761/0123040139到3583/int2023，正式会话816219、消息137624619/索引2；一次负草稿与一次发送，重复和状态查询无新增，窗口与自身资源回到基线。此轮int2023已有前序137621731/索引1，因此SDK实测证明会话复用，首次建会话能力复用同一调查中的原生首次实测及协议回归，不冒充又一次全新会话验收。命令和退出证据见启动说明。接收端展示、系统通知和已读未验证；测试文本保留供查看。功能验收后仅更新Markdown，不重复检查；后续提交与PR按用户明确授权执行，不自动合并或发布。

## PR #13 审计修复

- 工号渲染任务增加比外层CDP提前2秒的整轮截止，超时中止在途IPC；默认26秒，未提交为前置失败，已提交且证据不足为unknown。定时器与在途登记在finally释放，不通过增加搜索缓存、重试或提前接受首个候选来掩盖问题。
- 状态恢复按业务回执的正式消息ID调用 `getMessageByMsgId`，继续核对意图标记、会话和双方UID，不受最新100条窗口限制。精确查询失败保留方法与原生错误。
- 工号入口只复制operationId/verifyTimeoutMs，普通SendOptions里的会话、引用和提及不进入载荷或意图指纹，空正文仍失败。Fake保留自定义成功正式会话ID，结果、回执、模拟会话及注入历史/撤回目标一致，不制造回声。
- 专项示例用独立连接取消并等候本次key，清理本代Hook及默认binding；保留其他代资源，错误不跳过后续退出。发送任务拥有自己的回执监听，Hook只借用观察登记，关闭不移除同Hook下其他任务的监听。此归属问题以加强后的并发回归先失败再修正，没有缩到Hook安装前来回避。

核心新增6项回归在修复前全部失败，修复后的文本/业务回执/Fake四文件105项通过；示例清理4项通过。同Hook并发用例加强后先因另一任务监听被移除而失败，修正后示例与既有事件生命周期46项通过。新增合计14项，均使用模拟时钟或明确Promise信号，没有真实睡眠。

首次 `pnpm check` 的构建、类型和395项测试通过，lint因新增测试直接返回ES2022类型声明未包含的 `Promise.withResolvers()` 结果失败；改用仓库现有Promise构造器约定后完整通过。随后修正同Hook监听归属，再运行最终 `pnpm check`：build/typecheck、32文件395项及lint全部通过。未压制错误、升级依赖或修改TS目标，未重跑已知无关的额外测试类型检查。真实KK9为Electron22/Chromium108，生成清理脚本同样保留其支持的Promise构造器。

真机只读测量当前授权int2023搜索三次为9.07–21.78ms，每次1人、第一页即末页；这不代表所有账号或大量候选场景。前序审计的每页3.5秒是模拟延迟，不是原生性能数据。源码入口及最终构建入口均使用前序真实业务回执和真实精确记录恢复816219/137624619，只有操作Store是本地临时声明。最终构建还实测关闭本轮Driver自己的CDP连接，确认本代Hook残留后经独立连接清理回到基线。实际命令、元数据与未验证边界见启动说明；本轮没有发送或撤回，未改公共API、Store形状或原生协议，未提交、推送、合并或发布。

## 接收图片原图下载

`KK9ImageInfo` 新增 `originalFilePath/originalUri`，分别保留原生 `filepath_h/uri_h`，不覆盖可能是缩略图的 `filePath/uri`。`IKK9Driver.downloadImage(image, fullPath)` 通过原生 `download` 下载原图，确认指定目标为非空普通文件后返回；业务错误、超时和文件读取错误抛含资源及路径的 `DriverError(IMAGE_DOWNLOAD_FAILED)`。只有无独立原图字段的单一资源可以使用 `uri`，明确的原图缺失不能降级缩略图。缓存目录创建、保留期、应用大小限制及跨机器上传由消费方负责。

新增 `tests/image-download.test.ts` 七条行为回归，修复前全部失败，修复后全部通过。测试执行实际生成的 IPC 脚本，验证双资源选择、原图文件字节、单一资源、原生失败上下文、code0 无文件、禁止缩略图降级及 Fake 真实资源写入。审查时临时改为缩略图优先，字节回归按预期失败；恢复后七条再次通过。唯一一次完整 `pnpm check` 的 build/typecheck、33 文件 402 项测试及 lint 通过，随后变异恢复到同一源码，未修改依赖或公共发送协议。

本次真实验证复用用户此前发送的私聊图片137677807，不发送新消息：从原生记录得到独立原图URI，本次构建的Driver实际下载一次，KK9 nativeImage解码580×180 PNG、138182字节。配套AstrBot桥接编译产物经隔离的真实HTTP服务上传，真实AstrBot Image读取的文件与下载原图逐字节相同。命令为插件仓库的 `python.exe artifacts/tmp/original-image-smoke.py`；临时脚本及隔离目录验证后删除。只建立独立CDP连接，未接管生产Driver Hook、未重启生产bridge、未派发聊天事件或调用识图模型。本结果只证明原图下载和输入链路，不代替生产模型识图验收；未提交、推送或发布。


## 原图来源审计修复

原图来源规则集中在 `src/utils/image.ts` 的 `hasOriginalImageSource/getOriginalImageUri`，真实下载、Fake 与 AstrBot 桥接共用。存在原图字段时只接受原图 URI，包括字段显式为空的情况；只有两个原图字段都未提供时才接受单一 `uri`。不改变下载 API 参数、发送契约或持久数据，不增加兼容路径。

新增两项空字段回归在修复前均因错误下载缩略图而失败。修复后实际执行 `pnpm check`，build/typecheck、33 文件 404 项测试及 lint 全部通过。运行插件仓库的 `node artifacts/tmp/source-rule-smoke.mjs`，本次构建的原生下载函数将已有消息137677807的原图写入 `.part` 文件，KK9 nativeImage 解码为580×180、138182字节；验证完成后删除临时文件并断开独立 CDP。烟测初次因 Windows ESM 导入未使用 file URL 而在加载阶段失败，改为 file URL 后通过，不是生产实现错误。

没有发送消息、调用识图模型、接管生产 Hook 或重启生产桥接。原生下载超时不取消后台写入；消费方使用每次独占的临时文件和完成后重命名发布，缓存管理仍不进入 Driver。

## 2.0.1 文字语音代理与超时释放

文字合成读取运行 Driver 的 Node 进程中非空 `HTTPS_PROXY`，其次 `HTTP_PROXY`，交给 Edge SDK 已有代理选项；未配置时直连，指定代理失败保留原始原因，不自动切换网络路径。代理 CONNECT 无响应时，Edge 补丁通过本次连接的 AbortSignal 取消代理底层连接；不增加 TTS 引擎、配置项或重试。

新增「代理 CONNECT 挂起时超时必须关闭代理 TCP 连接」回归，修复前明确失败，补丁后通过。最终 `pnpm install --frozen-lockfile && pnpm check` 的安装、构建、类型检查、33 文件 410 项测试与 lint 通过；锁文件仅更新 Edge 补丁哈希，依赖版本与依赖图不变。

独立 Node 进程实际运行已安装的 `EdgeTTS.ttsPromise`，本地代理接受 CONNECT 后不返回响应：得到原始 `Timed out`，代理端观察到 TCP 关闭，没有生成音频或建立外网连接。此前真实 Edge 合成及 KK9 AMR 编码/回解证据仍保留，接收端播放不因本轮检查自动视为通过；没有发送聊天消息或重启服务。


## 跨机器附件（未发布）

本次只修改 Driver，不修改 `astrbot_plugin_kairo`。只读核实插件 `bridge/src/bridge.ts` 和 `attachments.ts`：发送输入来自桥接本机下载目录，没有发现必须保留“调用者传入 KK9 机器路径”的兼容约束；接收端原先直接读取 KK9 缓存，升级调用说明在 README。未新增兼容模式、共享磁盘、Windows 服务、监听端口、依赖、连接监督或发送重试。

实现与公开契约：

- `src/bridge/file-transfer.ts`：256 KiB 串行 CDP 真实文件传输，每请求 10 秒；远端独占临时目录和本机同目录 `.part` 发布。发送保留合法原文件名，非法 Windows 名称明确失败；两端短读短写按实际进度完成。
- `message-ops.ts` / `image-ops.ts`：Driver 本机文件先分块传输，Windows 临时路径才进入原生上传。保留 100 MiB 普通文件、20 MiB 图片限制，原文件名、图片原生解码及缩略图规则、防重与 `sent/failed/unknown` 不变。传输失败或传输中取消为前置失败，不创建原生草稿。
- `attachment-ops.ts` / `driver.ts` / `types/index.ts`：`downloadImage(image, fullPath)` 优先准确原图缓存，缓存 ENOENT 才下载准确原图；新增 `saveFile(fileInfo, fullPath)` 仅保存已缓存普通文件。目标属于 Driver 本机，完整校验后原子发布；不在宿主解析 Windows 路径，不用缩略图冒充原图，不扩展普通附件原生下载。
- `fake-driver.ts`：`setCachedFile` 注入实际缓存字节，原图下载与文件保存同样原子发布，未注入或空原图明确失败。
- `cdp/client.ts` 无需修改：HTTP/HTTPS 发现基址与返回的 WebSocket 地址均不限制本机；原样连接真实部署提供的可达地址。失效 Driver 仍由调用方重建。
- `voice-ops.ts` 与依赖补丁无需修改：文件在 Driver 机器读取、解码和重采样，只通过 CDP 传 PCM 给 KK9 内置 AMR 编码器；发送内联 AMR，不传本机文件路径。

临时文件不能根据四秒 IPC 等待结束就删除。远端真实 `main.js` 取证确认 `sendMessageNew` 先 await 资源上传，再发送与业务回调；`sendingImgBeforeHandle` await 文件复制。SDK 原生文件 IPC 独立保留本次完成监听和读计数：超时、取消或连接失联后的 unknown 不重发，实际原生完成且租约归零后才清理。未进入原生操作的文件按 60 秒空闲回收，每块刷新；不删除原生图片缓存。即时清理失败保留错误，后台迟到清理错误写远端控制台；原生永久不回包时保留仍可能在用的资源。客户端异常退出造成的遗留目录不会由新连接猜测并强删。

实际验证：

1. `pnpm exec vitest run tests/remote-send.test.ts` 修复前四项全部失败，证明原生仍使用宿主路径及传输失败边界缺失。
2. 首次五文件集成回归 80 项中 78 通过；原生无文件夹具需删除新增的预建临时文件，继续保留 ENOENT 断言；图片无效输入改为验证无原生请求，不再固定错误措辞。修正后的 `pnpm exec vitest run tests/native-media.test.ts tests/image-download.test.ts` 58 项通过。
3. 首次 `pnpm check` 构建、类型与 451 项测试通过，lint 报清理 finally 抛错及 WebSocket 数据解码类型问题；调整为清理后统一传播错误、完整解码 RawData，不禁用规则。最终 `pnpm check` 的 build/typecheck、36 文件 451 项及 lint 全部通过。没有重复运行已知无关的测试/示例额外全量类型检查。
4. 临时去掉临时文件清理的 readers 条件，`pnpm exec vitest run tests/remote-send.test.ts -t "迟到完成"` 两项均因文件过早删除失败；恢复同一源码后两项通过，没有保留变异。
5. Linux Node 使用本次构建真实连接 `172.16.0.18:9222`，执行 `examples/verify-remote-files.ts --large`：100 MiB 文件真实跨机往返且 SHA256 一致，缓存原图保存与 Windows nativeImage 640×360 解码一致，所有本轮临时文件释放。命令、摘要及未验证边界见启动说明。

新增或更新的行为回归集中于 `file-transfer.test.ts`、`remote-send.test.ts`、`image-download.test.ts`、`cdp-remote.test.ts` 与既有 `native-media.test.ts`；同时复用语音、生命周期和操作状态全套回归。本次没有自动提交、推送、发布或改插件的固定版本。

README 的插件 TypeScript 示例另用 TypeScript 编译器内存 Program、NodeNext 严格模式和本轮 dist 声明进行检查，诊断为 0、退出码 0；没有创建或保留一次性示例文件。这仅证明示例接口类型正确，不冒充插件仓库端到端验收。

### 已授权跨机器消息发送补充

新增 `examples/verify-remote-send.ts`，在真实Linux Node通过构建后的公开ESM入口发送图片、普通文件和WAV文件语音。身份、对端账号、精确群ID/名/接收对象及双确认门禁均先核对；可选会话参数仅限本次已授权双目标。未知发送只查询，不新建意图重发；消息保留、不撤回或切换会话。

当前 `kairo / UID3583` 向董仕林私聊816219与测试123群793803各发送三条成功，正式ID依次为137854071/073/077与137855053/055/057。两张服务器原图和两个服务器文件重新下载到Linux，与各自输入逐字节一致；两语音真实AMR回解16160采样、duration3、32364字节播放WAV与正式AMR回解一致。用户随后反馈验证通过。准确命令、索引、门禁、证据和未完成的单条防重专项见启动说明。

首次验收把数据库中的语音记录误当作已经生成播放filepath，语音发送成功后资源检查失败；正常最大索引历史读取会触发原生服务器同步并生成播放缓存，按该契约只读复核已发送语音成功，没有放宽WAV一致性断言、重发或修改生产代码。随后仅补群三条。两轮退出监听/采集函数恢复，活动窗口不变、临时传输和在途为0、无Driver Hook，SDK临时文件已删除；正式媒体缓存保留。新增验收脚本ESLint通过，未重试此前403的文字TTS。

### PR #17 评审问题修复

- 原图规范化按字段是否提供保留 `filepath_h/uri_h` 的显式空值，不再将其丢成 `undefined`。来源选择仍由现有原图规则负责；新增原生节点→规范化→公开Driver/Fake完整回归，拒绝把已有缩略图保存成原图，并保留已有目标。
- Linux本地输入以 `O_RDONLY | O_NONBLOCK` 打开，随后仍用描述符 `stat().isFile()` 拒绝FIFO等非普通输入；无需等待写端，也不留下检查／打开间的替换窗口。Windows继续原有只读打开。新增Linux专属真实FIFO回归，核对前置失败、无原生提交及并发断开完成；不增加重试、监督或额外配置。
- 远端释放的统一边界通过现有日志出口发出 `warn / Driver运行异常 / errorType: driver`，`runId` 为本次传输ID，可关联仍保留的远端Map项。随后仍抛原异常，原有失败／unknown保留清理错误；已确认sent不写入不合法的error、不降级或重发。保持现有日志白名单，不输出路径或原始异常正文，不增加公开字段。公开文件和图片发送的EPERM回归核对告警、同一正式ID、防重／查询无新增，以及原生缓存保留。

新增回归首次在Windows准确失败4项（两个空原图字段、两个成功发送后缺少告警），Linux用例按平台跳过。最初的公开结果整对象等值断言还比较了每次新建的撤回闭包，改为核对真正的消费契约：sent、同一正式ID及仅一次原生提交；没有修改生产撤回行为。

最终在Windows Node22.23、pnpm11.19运行 `pnpm check`，构建、类型检查、36文件455项测试与lint通过，1项Linux专属用例跳过。真实Debian Linux Node24.18另从本轮dist公开入口验证无写端FIFO直接失败、并发disconnect及时完成，全程未打开写端、原生IPC0，退出0；证据 `tmp/pr17-fixed-fifo.json`。未在Linux运行完整Vitest，未重新安装跨平台依赖。

修复后执行 `examples/verify-remote-files.ts` 默认真机脚本：Linux输入786469字节经CDP传到Windows并保存回Linux，SHA256 `d1679c45335f37b8acdcdf92749e13f4c18c54b71cf17e0b097c90cc83f6763c` 一致；缓存原图640×360正确保存、本轮远端文件全部释放、消息操作0、退出0。没有向真实客户端制造EPERM或改变权限，没有重新发送六条已验收消息。

## 只读人员搜索

新增 `searchEmployees(keyword, timeoutMs?)`、`KK9EmployeeSearchItem` 和 `KK9EmployeeSearchResult`，位于现有 `BridgeOrgOps`、Driver、Fake及包入口；不改变现有工号发送、档案展示或Store。内部全分页后按UID读取档案及全部部门路径，不增加依赖、缓存、重试、游标或选择状态。

当前远端 KK9 `main.js` 与真实只读调用已核对：`unionSearch(type:user)` 通过 `getUsersByKwd` 使用数据库 `limit/offset`，原始短页表示结束，不按去重后的候选数停止；匹配基于当前账号权限/等级范围内的原生summary。`getMemberDetail` 只提供默认部门链，全部部门必须调用 `getAllDeptPaths(UID)`，返回多条 `{ deptInfo, deptPaths }`，每条链按祖先到叶子排序且受可见权限限制。未提供部门返回null，不能从职位或默认部门补齐。

搜索候选独立于 `parseEmployee` 的展示回退。工号仅取原生 `login_name`；缺姓名/工号返回null，非空值保留原文与工号前导零。错UID、档案缺席、畸形路径、任意查询失败及整轮超时均抛带方法/页码/UID及原生原因的DriverError，不丢候选后宣称完整。默认总期限30000ms，每次原生请求受剩余期限约束。Fake通过独立 `setSearchEmployees` 注入候选，不读取展示工号。

新增14项原生行为回归首次全部因方法未实现失败；接入后 `pnpm exec vitest run tests/bridge-org-ops.test.ts tests/driver.test.ts tests/fake-driver.test.ts` 3文件92项通过。临时把结束条件改成去重UID数量后，“按原始页长度”回归准确捕获后页同名漏人；已恢复原始页长度条件。源码Bridge真机调用已确认董仕林5761的真实工号0123040139及部门null，当前账号3583/kairo返回部门“测试”；Fake实际调用保留两个同名UID并合并同人多部门，发送记录为空。

本机默认Node14不能运行锁定pnpm；使用已有 `C:/Users/dongshilin/AppData/Local/pi-node/current/node.exe`（22.23.0）及pnpm11.19，不升级依赖或改运行配置。LSP仍初始化退出code0；实际引用由现有调用检索与行为回归补足。jshookmcp附着忽略远端wsEndpoint连接默认端口的问题已报告，改用现有CdpClient独立只读取证，没有修改客户端安装包或共享工具。

最终 `pnpm check` 通过build/typecheck、36文件488项测试及lint，1项既有Linux专属FIFO回归在Windows跳过。首次完整检查仅新增Fake测试的三处 `structuredClone` 全局引用触发ESLint no-undef；改为明确使用 `globalThis.structuredClone`，保留深拷贝和全部状态断言后重新完整通过，没有改全局规则或弱化测试。

复用该构建运行两次 `examples/verify-native-employee-search.ts`：3583/kairo分别搜索董仕林5761和kairo3583，公开Driver结果与独立原生分页、真实工号及全部可见部门链一致。每次搜索仅各一次unionSearch/getMemberDetail/getAllDeptPaths；会话集合、窗口816219、已读索引5/181不变，实时事件0。退出message监听回1、自有Hook/binding/观察器false、在途0，两个CDP断开，进程exit0。

专项首次运行误把原生 `sessionsInfo` 数组当成字典并拒绝，未进入Driver搜索；保留失败报告后按已核实原生数组修正快照模型，两次真机通过。此后单独运行 `pnpm exec eslint examples/verify-native-employee-search.ts` 通过；生产源码、类型和测试在完整检查通过后未再改变，没有冒称修正前脚本成功。真实同名、多部门、多页、缺工号、故障及超时未制造，相关边界由行为回归覆盖；两条真实样本只证明本次可见结果，不代表全公司或目录快照。临时协议/烟测脚本已移除，必要JSON证据保留；未发送、撤回、创建会话、标已读、提交、推送或发布。

### 人员搜索评审修复

修复范围仅为搜索期限及人员搜索专项。公开搜索类型、全分页、UID去重和只读契约不变。共享 `callIpcToData(cdp, method, args?, timeoutMs?, cdpWaitBudgetMs?)` 新增可选第五参数：第四参数是渲染进程IPC期限，第五参数是CDP等待预算上限，实际等待取该预算与 `timeoutMs + 1000` 的较小值；省略时保留既有调用语义。只有搜索入口传入剩余整轮预算，其他查询未改，不新增依赖、重试、缓存或连接框架。

专项删除搜索期间的内层finally：成功后恢复透明观察器，再验收方法完整性；失败先记录原始错误，再从唯一退出路径分别清理。独立查询保留方法、原生数字错误码及error/message。独立CDP的异步error会中断当前操作，临时竞速监听在当前操作结束后释放；退出期间仍保留错误记录。先退出Driver终止在途搜索，再用健康独立连接恢复本次探针，并仅释放仍归本启动代次的Hook和binding，不删除其他代实例资源。

新增17项行为回归。修复前期限回归3失败、23通过，专项入口回归5失败、5通过，均准确命中已复现问题。修复后 `pnpm exec vitest run tests/bridge-search-deadline.test.ts tests/bridge-org-ops.test.ts tests/native-employee-search-example.test.ts tests/bridge-rpc.test.ts tests/native-user-text-example-cleanup.test.ts tests/driver.test.ts tests/fake-driver.test.ts` 七文件119项通过。专项测试执行实际入口、Bridge/RPC/EventBridge和生成渲染脚本，覆盖双错、单连接失联、其他代资源保护、异步及退出error、迟到回复不继续查询。

末端期限回归覆盖最后一位候选的部门回复恰好到期、超期及期限前返回。临时仅跳过最后一次部门返回后的期限检查，两项拒绝回归准确失败；恢复后源码与修复版逐字一致。最终 `pnpm check` 通过build/typecheck、38文件505项测试和lint，1项既有Linux专属用例在Windows跳过。首次完整检查在测试全部通过后发现两处新lint诊断：移除竞速后的重复判错分支、按WebSocket字节类型解码后重新完整通过；没有抑制规则或弱化断言。

复用最终构建执行真实CdpClient与本地HTTP/WebSocket烟测：连接保持在线但不回Runtime.evaluate，80ms预算实测85ms拒绝，无后续查询，连接正常退出；证据 `tmp/employee-search-deadline-fixed-evidence.json`。这是隔离调试协议验证，不是真机故障验收。

授权真机专项从公开ESM入口运行通过，3583/kairo搜索董仕林5761；运行ID `fb86b55f-ed14-489f-a0e3-1242510874d6`。每个搜索方法各一次，与独立原生全分页、真实工号和全部可见部门一致；会话793803/816219、读索引181/20、窗口816219不变，实时事件0；退出监听回1，自有Hook、binding、观察器、探针均无残留，在途0，两连接退出、exit0。首次运行因已有其他代桥接而拒绝接管，失败报告保留；后续独立观察发现原桥接已不存在后才重新运行，本轮未清除原桥接，其退出来源未核实。详见启动记录。

真实单连接失联、异步error和期限故障没有在KK9上制造，这些分支由隔离行为回归覆盖；真机只证明本次账号的正常只读搜索和退出。临时烟测脚本已移除，保留必要JSON证据；没有发送、撤回、创建会话、标已读、提交、推送或合并。

## Edge TTS 403 协议修复

调查开始时依据远端 main `1c4223fee51296ff68aa8f18b98d406bcdd800c8` 与实际源码；保留当时人员搜索分支及已有工作区修改，调查验收阶段没有切分支、提交、推送或修改插件。未重新请求旧版服务确认已报告的403。后续按用户授权提交本次TTS修复，准确SHA以Git提交记录为准；人员搜索修改不纳入本次修复提交。

### 原因与选择

已确认代理确实承载旧服务请求，因此本次不是代理未生效。上游 [#490](https://github.com/rany2/edge-tts/issues/490) 记录旧端点与v1握手被拒；[#492](https://github.com/rany2/edge-tts/pull/492) 提供v2算法。实际检查 [node-edge-tts 1.2.11发布包](https://registry.npmjs.org/node-edge-tts/1.2.11) 的 `dist/drm.js` 与 `dist/edge-tts.js`：它未实现v2，而是把服务改为 `api.msedgeservices.com/tts/cognitiveservices/websocket/v1`，键参数改为 `Ocp-Apim-Subscription-Key`，移除旧Host覆盖。该路径与上游 [#491的新端点方案](https://github.com/rany2/edge-tts/pull/491) 一致；#491后来被#492替代，不代表当前Node发布包已采用#492。

原始1.2.11发布包先在桥接机器172.16.3.76、既有 `http://127.0.0.1:7897` 代理下独立合成成功：25056字节MP3、24000Hz、100224采样、4.176秒、RMS 0.11202324327109202。因此采用最小且已经实测的Node SDK修复，不移植Python实现、不添加v2算法、临时token、新引擎、子进程、重试或备用端点。此证据只证明当前服务可接受该上游协议，不承诺服务今后继续接受v1。

### 实现与消费方同步

- `package.json` 精确锁定 `node-edge-tts: 1.2.11`，更新锁文件的SDK版本、包完整性与补丁哈希，其他依赖版本保持原样。
- `patches/node-edge-tts@1.2.11.patch` 移植原有握手/整轮期限、代理底层AbortSignal取消、文件流和WebSocket关闭、错误传播及晚到消息隔离；保留1.2.11上游端点、元数据解析和未使用的流式接口。删除旧1.2.10补丁，更新 `pnpm-workspace.yaml`；WAV补丁不变。
- `voice-ops.ts`、消息提交、公开类型与调用形状均不改：`HTTPS_PROXY`优先、`HTTP_PROXY`其次、空白trim、未配置直连、指定代理失败不回退；30秒合成期限、临时文件清理、MP3/WAV解码、8kHz重采样、KK9内置AMR编码、取消后不提交及operationId防重继续使用原路径。
- 新增 `examples/verify-tts.ts`：使用本轮构建的真实语音准备实现和独立CdpClient，只合成、编码/回解和检查声音/时长；不创建Driver、不调用聊天IPC或清理既有Hook。

插件须将当前固定提交 `1c4223fee51296ff68aa8f18b98d406bcdd800c8` 换成包含本次修改的Driver提交，准确修复SHA以Git提交记录为准。同步准备脚本、vendor、依赖与锁文件，并在消费项目配置 `node-edge-tts@1.2.11: patches/node-edge-tts@1.2.11.patch`，移除旧1.2.10条目，继续配置 `@audio/decode-wav@1.5.0` 补丁；源码包不会替消费项目自动应用补丁。仅替换版本号或仅保留旧SHA不能取得完整修复。

### 实际验证与未通过项

新增本地真实HTTP/WebSocket协议回归：仅接受新Host、路径及订阅键，完成实际SDK握手并写出音频；旧依赖先返回本地401，升级后通过，没有访问旧外部端点。代理回归更新为真实CONNECT到新Host，继续检查只选指定代理、失败不直连。`pnpm exec vitest run tests/voice-ops.test.ts tests/node-edge-tts-boundary.test.ts tests/native-media.test.ts` 的3文件54项全部通过，涵盖现有超时、连接关闭、错误、临时文件、编码、取消及防重。

`pnpm install --frozen-lockfile` 成功。首次更新安装额外解析了pino-pretty和@types/ws的新版本；重新生成仅变更Edge的锁文件并冻结安装，已恢复这两个依赖及其原依赖图，未保留无关升级。

两次 `pnpm check` 均通过build/typecheck，测试均为505通过、1失败、1跳过，未到lint；失败都位于已有工作区 `tests/bridge-search-deadline.test.ts:108` 的 `vi.getTimerCount() === 0`，实际为1，分别出现在getAllDeptPaths/unionSearch分支。没有修改该人员搜索测试、相关源码或断言，也不把全套check记为通过。另行 `pnpm lint` 首次指出新增握手回归的多余类型断言和RawData解码问题；修正后再次 `pnpm lint` 全部通过。LSP初始化仍退出code0，未把导航失败写为成功。

最终Driver真实独立合成/KK9编码与回解成功：4395字节AMR、33440采样、实际4.18秒、显示5秒、RMS 0.1094697409780753。已有生产Hook前后均存在，脚本没有接管或释放它；独立CDP退出。准确命令与边界见[启动说明](KK9-STARTUP.md#edge-tts-403-修复与独立合成验收)。没有发送聊天消息、重启服务、改生产环境或把此结果当作接收端播放验收。

## 群全员五字段查询

新增公开 `getGroupMembers(sessionId, timeoutMs?)` 与独立 `KK9GroupMember` 类型；Driver、Bridge、Fake及包入口同步。现有人员搜索与群查询复用准确档案、全部可见部门路径和有界原生/CDP等待，不改变搜索结果形状。群接口从原生会话解析群对象，再读取原生全部成员；按UID去重，姓名/工号/岗位仅取 `name/login_name/pos`，缺失为null，任一错误或超时不返回部分名单。没有新增依赖、缓存、重试或兼容层。

原版远端main.js已核对：`getGroupsAllMembers(groupId)` 最终直接返回全员数组，内部变量名是 `allUsers`，不是响应包装字段；原生无分页或limit。服务器同步内部catch可能继续读本地名单，不能宣称服务器最新状态。`getConversations.sessionsInfo` 实际为会话数组；本轮专项按实际数组白名单提取身份与索引，未扩展修改其他原有类型。

新增19项原生回归先全部失败、实现后通过，覆盖201人不截断、同UID/同名、空群、真实字段缺失、非群/错群、错档案、无效部门、原生错误与末端期限。Fake新增5项覆盖群隔离、全部部门合并、拷贝隔离、缺失与只读、非法参数和完成时截止；不从展示或搜索档案补真实工号。错人档案条件变异被专项准确捕获，已恢复准确UID匹配。

实际定点命令：`pnpm exec vitest run tests/bridge-org-ops.test.ts tests/bridge-search-deadline.test.ts`（44通过、1既有定时器断言失败）；`pnpm exec vitest run tests/fake-driver.test.ts tests/driver.test.ts`（78通过）。本轮一次 `pnpm check` 通过build/typecheck，38文件中529测试通过、1失败、1既有Linux用例跳过，失败仍为已有 `tests/bridge-search-deadline.test.ts:108` 的定时器期望0/实际1，与上节既有失败相同；未到lint，不称全套通过，也未改动或放宽该断言。

随后修正Fake新增方法的无await与拒绝原因lint诊断，最终 `pnpm build && pnpm typecheck && pnpm exec vitest run tests/fake-driver.test.ts && pnpm lint` 全部通过（Fake58项）。真机专项仅再修正 `sessionsInfo` 的实际数组模型，之后 `pnpm exec eslint examples/verify-native-group-members.ts` 及构建入口实际运行通过；没有为已知无关失败反复运行全套测试，也未运行已知无关的额外测试全量类型检查。

`pnpm diagnose help` 与授权 `group-members 793803` 实际运行通过，输出6人全部五列。最终 `examples/verify-native-group-members.ts` 通过构建后公开 `BridgeOrgOps` 与独立原生逐字段对照，窗口/会话/索引/监听/已有生产Hook不变，独立连接退出。名单查询本身无需事件桥，专项和命令行不接管已有实例；Driver门面仍直接委托同一实现。准确命令、原始失败报告和未实测边界见[群全员验收](KK9-STARTUP.md#群全员资料只读验收)。

LSP引用查询本轮初始化退出code0，已检索真实调用补足，不冒充导航成功；挂载Electron附着工具忽略远端wsEndpoint已报告，改用已有CdpClient只读核对源码。没有修改安装包、生产服务、依赖/锁文件，未发送、撤回、标已读、提交或推送。

## PR #19 群查询评审修复

Fake群查询现与真实实现对齐：非法会话ID、非群目标及无效群接收对象返回 `INVALID_SESSION_ID`，未知会话返回 `IPC_INVALID_RESPONSE`；无效期限和超时仍为 `IPC_QUERY_FAILED`。现有标识校验助手由具体调用指定错误码，Fake注入数据校验保留原分类；没有新增错误框架、回退、依赖或公开签名变化，真实原生实现未修改。

`tests/bridge-org-ops.test.ts` 增加8项跨实现参数化对照：空/零会话ID、私聊、讨论组、服务号、未知会话、无效群对象及无效期限。两种实现共用同组场景和预期，原生一侧实际执行生成的IPC脚本；目标无效时不得继续查询成员。旧私聊单独拒绝用例迁入对照，净增7项测试；原有Fake错误预期同步对齐，注入校验、超时和只读断言保持不变。

修复前 `pnpm exec vitest run tests/bridge-org-ops.test.ts tests/fake-driver.test.ts -t "群查询错误契约对照|群成员查询前后|群成员拒绝非法"` 观察到9失败、1通过。修复后 `pnpm exec vitest run tests/bridge-org-ops.test.ts tests/fake-driver.test.ts tests/driver.test.ts` 的126项全部通过。

隔离副本将原生类型校验变为仅拒绝私聊type0，使用临时Vitest配置运行 `-t "群查询错误契约对照.*(讨论组|服务号)"`，新增两条回归均因误返回成员而按预期失败。原生源码逐字保持不变，变异副本及配置已删除；没有把变异或临时探针留入产品。

本轮只执行一次最终 `pnpm check`，build/typecheck、38文件537项测试及lint全部通过，1项既有Linux专属用例跳过。此前人员搜索定时器断言失败本轮未出现，未改其源码/断言，也不宣称修复了该既有问题；历史失败记录保留。

复用本轮构建，通过 `pnpm exec tsx -e` 动态导入 `@kairo/driver` 公开包入口，实际调用Fake及执行原生脚本的Bridge：正常群五字段一致，上述8类错误分类一致，Fake会话与发送记录不变。该烟测为隔离运行时，不连接真实KK9；本次仅改Fake错误分类与测试，未重复上节真机查询、发送或制造真实故障。README、计划与任务状态同步；尚未提交、推送或合并。

## 定向卡片与附件合入 Driver

将 AstrBot 插件原先维护的 `@kairo/driver` 定向发送补丁合入六个源码文件：公开发送选项、`BridgeMessageOps`、卡片/图片原生提交、Driver 门面及 Fake。保留当前 main 的群全员查询，不覆盖新接口；编译产物继续由标准 build/prepack 生成，不提交 `dist` 或另留 Driver 自身补丁。

`targetLoginName` 仅支持三类通知卡片、图片和文件，与 `targetSessionId` 互斥。准确工号复用既有原生人员查找、权限与 sessionID0 首次提交，业务回执关联正式会话；不预发文本、不依赖当前窗口。文件传输租约、取消、unknown 防重及操作指纹保持现有语义。`sendTextToUser` 仍只复制其两个公开选项，不增加兼容入口。Driver 门面在 await 前固定是否使用工号目标，调用方修改选项也不会改变成功后的日志或快捷撤回会话。

移植回归使用本仓库 Vitest 与既有 `native-send-runtime`，直接执行真实生成脚本，不把插件的安装路径或第二套渲染器替身搬入 Driver。源码入口隔离烟测先观察到原实现工号公告返回前置 failed/零草稿；合入后同场景 sent、正式私聊94001、准确接收者91003、contentType8，重复操作仍只有一个草稿。本轮未连接或发送真实 KK9 消息，不能以此代替接收端呈现验收。

实际执行 `pnpm exec prettier --write tests/native-user-cards.test.ts tests/native-user-media.test.ts` 后，`pnpm check` 的 build/typecheck、40文件706项测试及lint全部通过，1项既有Linux专属用例在Windows跳过。新增169项行为回归覆盖三类卡片及两类附件的首次/已有会话、准确工号、原生失败与回执、防重、取消/截止、真实字节和迟到读取租约。原有人员搜索定时器断言本轮未失败，未改动该实现或测试，不宣称修复历史偶发失败。

审查临时把应用通知门面的工号模式固定为false，执行 `pnpm exec vitest run tests/native-user-cards.test.ts -t "公开应用通知门面"`，新回归因已确认卡片缺少快捷撤回而准确失败；恢复正确源码后同项通过。恢复后源码快照与全套通过时一致，没有保留变异。未发送、撤回或切换真实KK9会话；原有真机验收不扩展为新增定向媒体/卡片的接收端验收。


## 定向语音与连接发送者绑定合入

将消费插件的语音补丁合入源码：准确工号能力、取消 signal、正式会话日志/撤回及连接 UID 绑定由 Driver 自己提供，不再要求消费项目维护 Driver 自身补丁。公开 sendVoice 参数、operationId 指纹、结果及数据库格式不变；内部发送必须显式传入连接绑定 UID，不从准备后的账号猜测。新增 Vitest 模块复用原生运行时，仅替换外部 TTS、编码器和 IPC。

本轮运行定向 prettier 后执行 pnpm check，首次新增回归错误地要求在途重复调用等到最终业务失败；既有 Store 在首次结果未确认时只返回 unknown。将测试改为用原生请求门闩确定性观察在途 unknown，释放后再核对最终 failed/unknown，保留单次编码/草稿/提交与重放断言，未改变产品防重实现。

再次 pnpm check 的 build/typecheck 通过，42 文件中 757 项通过、1 项失败、1 项既有 Linux 专属跳过；新增原生语音 31 项与 Fake 21 项均通过。失败为历史已记录的 tests/bridge-search-deadline.test.ts:108 定时器期望0/实际1，本次发生于 getMemberDetail 分支。未改相关源码/测试、放宽断言或重复运行确认，不将完整检查称为全绿。单独 lint 指出新增 TTS 替身的无 await async，改为显式返回已完成 Promise；最终 `pnpm exec vitest run tests/native-user-voice.test.ts tests/fake-user-voice.test.ts && pnpm lint` 的52项及全量lint通过。

复用构建产物的独立 Node 内联烟测实际导入本仓库 dist：准确工号正常语音为 sent；编码及查人期间由绑定 UID 1 改为99，均前置 failed、零草稿零提交。未连接真实 KK9、发送消息或验收播放；没有新增 Driver 补丁、依赖、锁文件或兼容层。

