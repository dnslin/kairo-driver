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
