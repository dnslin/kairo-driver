# Kairo Driver

面向 KK9 桌面客户端的 TypeScript Driver，通过本机 CDP 连接客户端，提供消息收发、会话管理和组织架构查询。

从 [Kairo](https://github.com/dnslin/kairo) 的 `packages/driver` 独立而来，保留包名 `@kairo/driver`。它是客户端 SDK，需要已登录的 KK9；不包含 Bot 服务、模型调用、知识库或 AstrBot 适配器。

## 安装与检查

需要 Node.js `>=22.13.0`、pnpm `11.19.0`。本仓库的真机启动与验收步骤以 Windows KK9 客户端为准。

```bash
git clone https://github.com/dnslin/kairo-driver.git
cd kairo-driver
pnpm install --frozen-lockfile
pnpm check
```

也可以分别运行：

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

当前按源码仓库使用，尚未发布到 npm。音频依赖的两条补丁由根目录 `pnpm-workspace.yaml` 配置；将本包安装到其他项目时，消费项目也需要配置这些补丁，安装包本身不会自动应用它们。

## 接收消息

先按 [KK9 启动说明](docs/KK9-STARTUP.md) 启动客户端并登录。以下 ESM 示例可以在本仓库构建后使用：

```ts
import { KK9Driver } from '@kairo/driver';

const driver = new KK9Driver({
  cdp: {
    url: 'http://127.0.0.1:9222',
    pageMatch: 'renderer.html',
  },
});

driver.on('error', error => console.error('Driver 错误', error));
driver.on('message', message => {
  if (message.direction !== 'inbound') return;
  console.log('收到消息', message.sessionId, message.senderId, message.content);
});

await driver.connect();

process.once('SIGINT', () => {
  void driver.disconnect().catch(error => {
    console.error('断开失败', error);
    process.exitCode = 1;
  });
});
```

消息方向只比较原生发送者 UID 与实际登录 UID：他人为 `inbound`，本人为 `outbound`；缺少任一身份或属于系统通知时保留 `unknown`。昵称、`isMe/fromMe` 输入标志和业务角色不能代替身份。接入 Bot 时只把确认的入站消息交给上层，避免响应自己发出的消息。消息类型、提及、引用及附件字段见 [类型定义](src/types/index.ts)。

`origin` 只保留 `external/system/unknown`；已删除 `operator/bot_echo` 和 `recordBotSentMessageId/isBotSentMessageId`，没有兼容别名。本人方向不代表 SDK 发送：本机人工发送、其他设备本人消息与 SDK 回显都可以是 `outbound`。只有本实例取得本次业务成功回执并关联正式 ID 的实时回显才带 `sdkSendKey`，可用 `createNativeMessageKey('text', operationId)` 对照；历史查询不添加此确认标记。

实时聊天使用原生 `message` 与本机发送业务回调，不依赖聊天窗口、Vue 普通消息转发或消息气泡。会话状态包不制造聊天；普通系统通知保留；按 `sessionId:messageId` 去重，`message/at` 对同一身份各最多派发一次。SDK 原生包先到时暂存到本次发送结束，失败或未知后仍派发真实本人消息而不伪造确认。本机手工撤回仍需必要的 Vue 本地通知捕获；历史查询只返回记录，不重放实时事件。

T04 双目标SDK回显、真实新入站、本机人工本人消息、历史不重放、组件重建及真实组件缺席时的SDK回显和群入站已实测；私聊也有无组件接收记录，但专项标记放反，脚本判定未通过。按用户要求停止补测，已撤回本人测试消息并退出自有监听；真实状态更新等未验证项保留，不把离线回归写成真机通过。其他设备本人消息测试已按用户要求取消，不列验收缺项。证据与收尾结果见 [启动说明](docs/KK9-STARTUP.md#t04-原生实时事件专项验证)。

## 原生身份与会话

`getCurrentUserId()` 使用无参数原生 `getMemberDetail()` 取得实际登录 UID；`connect()` 也使用该身份，不以配置值代替登录账号。`getSessions()` 使用原生 `getConversations()`，不读取聊天窗口。空会话返回 `[]`，查询失败抛出保留方法、错误码与诊断的 `DriverError`，不会回退 DOM。

会话 `id` 是原生 `sessionID` 的字符串形式；`receiverId` 是私聊对端 UID，其他类型为原生 `typeID`；`nativeType` 保留原生类型数字。`type` 区分 `private`、`group`、`discussion`、`service` 和 `unknown`。原生会话列表不提供窗口 `active` 状态。

例如原生会话 `716791` 的对端 UID 是 `3585`；界面事件标识 `0-3585` 不是公开会话 ID。按会话发送、撤回、历史和已读操作使用明确原生会话；首次联系可使用下文的 `sendTextToUser()` 按准确工号发送。`getEmployeeBySession()` 接受原生会话 ID 或会话实体；查询 UID 请使用 `getUserProfile()`。数据查询和发送不读取当前窗口，SDK不再提供窗口切换接口。

已直接删除 `getCurrentSession/selectSession`、`KK9Session.active`、`SelectorsConfig/DriverConfig.selectors`、`PreSendCheckResult`、`SessionOps/MessageOps/SendOps`、`DEFAULT_SELECTORS/resolveSelectors` 与 `DomError`，没有兼容别名。`src/dom` 已删除；保留的 `parseEmployee/parseEmployeeList` 与 `readImageAsBase64/saveImageToFile` 分别位于 `src/utils/employee.ts`、`src/utils/image.ts`，仍由包入口导出。

## 指定会话读取历史

`getRecentMessages(session, limit = 20)` 必须传入 `getSessions()` 返回的会话实体，直接把其原生 `id` 传给 `getMessages`，不默认当前聊天，不按名称猜测目标，也不回退可见消息气泡。

```ts
const session = (await driver.getSessions()).find(item => item.id === nativeSessionId);
if (!session) throw new Error('未找到指定原生会话');
const history = await driver.getRecentMessages(session, 10);
```

`id` / `messageId` 是原生消息 ID，`msgIdx` 是原生消息索引，两者不能互换。历史保留原生撤回状态和系统记录，不派发 `message`、`at` 或 `recalled` 实时事件。空页返回 `[]`，原生失败或无效回包抛错；SDK 不猜测补页或自动重试。原生客户端内部可能补取历史并更新本地缓存；读取不会切换会话或标记已读。

`scanCompensationWindow({ sessionIds, fromTimestamp, toTimestamp?, maxMessagesPerSession? })` 按原生ID直接分页查询，不切窗口、不标已读、不重放事件。时间戳为毫秒闭区间，`toTimestamp` 默认调用时刻；每会话返回区间内最近N条并按原生索引升序排列，N默认20且必须为正整数。指定会话不依赖当前可见列表；省略 `sessionIds` 则查询原生会话列表。正常空范围返回 `[]`，不存在的指定会话、原生失败或无法继续分页抛错，不返回已收集部分。覆盖仅限原生当前可见历史与数量上限，不保证删除/隐藏以前的无界全量。

已删除 `startPolling`、`stopPolling`、`PollingConfig`、`DriverConfig.polling` 和扫描参数 `switchDelayMs`，没有兼容别名或后台替代轮询。调用方自行决定何时主动查询；接收新消息直接使用实时事件。

## 组织查询与标记已读

`getOrgEmployees(timeoutMs?)` 从原生可见根部门分页遍历并按UID去重；正常空返回 `[]`，任何部门/页错误或遍历中断抛错，不返回部分全量。`getUserProfile(uid)` 使用原生档案，正常缺席返回 `null`；已删除旧 `OrgOps` 及DOM回退，纯数据解析工具保留。

`markSessionRead(nativeSessionId)` 只接受明确原生ID；使用原生会话真实类型与最大消息索引调用 `readMessage`。不存在返回false，原生失败抛错，已读目标可幂等。不默认当前窗口、不按名称选择，也不手改Vue红点。该方法有真实已读副作用，必须由调用方限定已获授权的账号与目标；查询历史不会代为调用它。

## 指定会话撤回

`await driver.recallMessage(messageId, session)` 必须指定原生会话 ID 或 `KK9Session`，不接受会话名称、界面标识或省略目标。SDK 从该会话原生历史取得准确消息 ID 和索引，仅以 `type: own` 撤回本人消息，不切窗口、不扫描气泡、不用 0 猜索引。`SendResult.recall()` 固定本次发送目标，走同一撤回路径。

原生成功后派发 `recalled`；远端 `CancelMessage` 独立捕获，目标取正文 `content.msgID`，不是系统通知自身 ID。三类通知按会话与目标 ID 去重，查历史不重放。不合法、不存在、已撤回或非本人目标返回 `false`；原生失败抛出 `DriverError(RECALL_FAILED)`，保留会话、消息、已知索引与原生错误。已删除 `SendOps.recallMessage` 的 DOM 撤回，不提供兼容别名。KK9 本机菜单只有 Vue 本地通知，保留其 Hook 与组件重建观察，退出仅释放 SDK 自身资源。

## 发送消息

`sendText()` 和既有媒体发送必须提供明确原生 `targetSessionId`；缺省、界面标识或会话名称均不会改投当前窗口。文本直接读取原生身份与指定会话，预插入草稿、订阅本次业务回执后提交，不读聊天编辑器、按钮或 Vue。下面的函数使用上例中已连接的 `driver`，只有调用函数时才会发送：

```ts
import { randomUUID } from 'node:crypto';

async function sendToSession(targetSessionId: string, text: string) {
  const operationId = randomUUID();
  const result = await driver.sendText(text, { targetSessionId, operationId });

  if (result.status === 'unknown') {
    return driver.getSendStatus(operationId);
  }
  return result;
}
```

发送结果统一用必填 `status` 判别：`sent` 必有正式 `messageId`，只表示本次原生业务确认成功，不表示对端收到或已读；`failed` 必有实际 `error`，原生业务错误保留 `nativeCode` 和 `receipt`；`unknown` 表示可能已经提交但证据不足，不能重发。外层 IPC `code: 0`、正 ID 或历史存在记录均不能单独判成功，617 即使有正 ID 也仍是失败。

每次调用都返回稳定 `operationId`，省略输入时 SDK 为该意图生成一次。同一 ID 不能更换内容、目标、类型、提及或引用；重复调用只返回或查询原结果，不再次提交，包括明确前置失败。需要另一次发送时必须显式建立新意图。`getSendStatus()` 不发送消息；没有本次业务证据时保持 `unknown`。默认记录保存在内存，跨实例或进程接入复用调用方提供的 `SendOperationStore`；未新增数据库、迁移或兼容结果别名。

`verifyTimeoutMs` 控制取得负草稿后的业务回执等待；外层 `sendMessageNew` 请求超时只保留诊断，不提前结束这段等待。图片、卡片与文本使用同一等待约定。调用 `disconnect()` 时，尚未提交的声明与准备工作取消，已提交且没有业务证据的操作保持 `unknown`；仅清理本实例的监听。按会话发送固定调用时目标；按工号发送的快捷撤回绑定本次回执确认的正式会话。

自定义 `SendOperationStore.update()` 必须在一次原子更新中保留已确认的 `sent/failed`，不能让后到的 `unknown` 清除正式 ID、业务错误或回执；返回实际保留的记录，不能先读再写实现这个约束。默认内存 Store 已执行此规则。按工号发送新增指纹字段 `targetLoginName` 和记录字段 `sessionId`，自定义 Store 必须保留它们，并把工号纳入同意图冲突比较；Store 方法未新增，不提供旧数据迁移或兼容路径。

还支持图片、文件、富文本、引用回复、卡片、语音和撤回；完整方法见 [IKK9Driver](src/types/index.ts)。图片和文件路径属于运行 Driver 的机器，跨机器接入时由调用方传输实际文件。

### 按工号首次联系与文本通知

`sendTextToUser(loginName, text, options?)` 接受准确 `login_name`，不是显示名、UID或会话名称；只去掉工号首尾空白，大小写必须准确。无需对方已在会话列表，也无需先手动聊天。选项 `SendToUserOptions` 只包含 `operationId` 和 `verifyTimeoutMs`；入口只复制这两个字段，复用普通发送选项不会产生引用、提及或会话目标，空正文仍前置失败。本接口不支持本人设备会话。

```ts
async function notifyUser(loginName: string, text: string, operationId: string) {
  const result = await driver.sendTextToUser(loginName, text, { operationId });
  if (result.status === 'unknown') return driver.getSendStatus(operationId);
  // sent时result.sessionId是真正的私聊ID，result.recall()绑定该会话。
  return result;
}
```

原生人员搜索分页后按准确工号匹配并核对档案、私聊权限；找不到、歧义或查询失败均在提交前明确失败，不改投相似账号。KK9按双方UID解析或建立私聊，零值只用于原生首次提交，不作为公开会话ID。成功结果额外提供正式 `sessionId`；只有本次负草稿业务回执、双方UID和正式记录匹配才能判为 `sent`。

人员候选每页200人串行查询，必须查完后排除同工号不同UID，不能看到首个匹配就发送。工号发送的渲染任务设有 `verifyTimeoutMs + 18000ms` 整轮截止（默认26秒），比外层CDP期限提前2秒；超时中止后续IPC并清理本次登记。尚未提交时返回前置失败；已提交但证据不足时保持unknown，不重发。此限制防止超时任务继续发送，不代表人员搜索本身被加速。

同一 `operationId` 不能更换工号或正文；重复与 `getSendStatus()` 不再次找人或发送。工号状态恢复使用已采集成功回执中的正式消息ID精确查询，核对本次标记、会话与双方UID，不受最新100条历史窗口限制，也不能拿任意正ID记录补判成功。Fake按注入人员建立或复用模拟私聊；自定义成功结果提供正式会话ID时保留该ID及回执，不另行覆盖，不从发送请求制造消息历史或实时回声。

构建后真机命令、确认门禁和实测边界见 [按工号文本通知验收](docs/KK9-STARTUP.md#按工号文本通知验收)。

专项示例的Driver连接单独失联时，独立采集连接会先取消并等候本次消息键的任务退出，再清理本代Hook与绑定，不清理其他代资源。业务回执等待器属于发送任务；Hook关闭仅解除自己的观察登记，不移除其他任务的回执监听。


### 原生富文本、提及与引用

`sendRichText` 接受原文字符串或 `{ text, font }`。`font` 作用于整条消息，支持 `bold/italic/underline`、`fontSize`（pt）、`fontFamily` 和 `color`（`#RRGGBB`）。不解析 HTML、Markdown 或逐段样式；旧 HTML/片段对象及删除线、高亮等字段在提交前明确失败，不静默丢失格式。旧 HTML/CSS 转换导出和 `TextStyle/TextSegment` 已删除，字体类型改为 `TextFont`。

```ts
await driver.sendRichText(
  { text: '整条加粗\n保留换行', font: { bold: true, fontSize: 14, color: '#1890ff' } },
  { targetSessionId: privateSession.id }
);
await driver.sendText('请查收', {
  targetSessionId: groupSession.id,
  mentions: { uid: 3585, name: 'int2024' },
});
await driver.sendReply(
  { messageId: original.id, msgIdx: original.msgIdx },
  '收到',
  { targetSessionId: groupSession.id, mentions: { uid: 3585, name: 'int2024' } }
);
```

提及不再接受任意昵称字符串，UID 不得用会话 ID 代替。原生全体提及保留显式 `'all'`，是否有权限由真实业务回执决定；T08 真机验收不使用它。引用目标只接受消息 ID 和可选准确索引；发送者及真实内容从指定会话原生历史取得，不能提供摘要或伪造身份。提供索引时必须同时匹配消息 ID，不退回其他记录。引用自动携带被引用作者 UID，正文提及另行加入同一原生元数据。历史及实时规范化保留引用作者 UID、原生索引和正文提及。


### 原生卡片与合并转发

链接、业务、应用卡片、合并转发及语音均指定原生目标，复用本次业务回执与发送登记，不依赖编辑器、DOM 或 Vue，也不补即时气泡。语音继续复用AMR准备与两条音频依赖补丁。

`sendUrlCard({ title, summary, linkUrl, picUrl? }, options)` 使用原生链接字段；可不传图片，SDK 不伪造图片已下载或有效。`sendAppMessage({ title, content, linkUrl?, pcAppCode? }, options)` 的正文为原生 HTML；普通通知不要求应用编号，不要填造出的应用码。特定应用的打开能力须使用其真实配置。

`sendBizMessage` 必须显式提供 `bizType: 1 | 2`（任务/日程展示样式）与 `bizUrl`。`bizUrl` 是相对于客户端 `ekp_outer_domain` 的路径，不是完整外部网址。该接口只发送通知，不创建真实业务对象；点击详情还依赖接收端实际业务站点配置。

合并转发只接受来源原生会话及准确消息引用，正文、作者、发送时间与来源标题都从原生记录取得，不再接受手造简报、任意标题或虚构作者：

```ts
await driver.sendChatRecord({
  sourceSessionId: source.id,
  msgArray: [{ messageId: original.id, msgIdx: original.msgIdx! }],
}, { targetSessionId: target.id });
```

来源必须是可读取、未撤回且身份完整的正式消息；ID 和索引必须指向同一条记录。SDK 按原索引排序，保留真实子条目 ID/UID。业务确认不代表实际呈现，真机范围见 [T09 验证](docs/KK9-STARTUP.md#t09-原生卡片与合并转发验证)。

## 运行边界

- KK9 必须保持登录，CDP 端口只绑定 `127.0.0.1`。
- Driver 失效或调用 `disconnect()` 后，需要创建新实例再连接。调用方负责监听 `health`、恢复连接和安排重试；Kairo 应用原有的连接监督器没有包含在本包中。
- Driver 依赖 KK9 客户端内部接口，客户端升级后需要验证相关收发能力。
- `pnpm test` 是自动测试，不连接真实 KK9。真机命令会读取客户端数据，部分命令还会发送、撤回或标已读；必须限定授权身份与原生目标，操作范围见启动说明。
- 本机菜单撤回仍保留 `event-bridge.ts` 中已验收的Vue总线、会话撤回通知、`addRevokeMsg`及组件重建用 `MutationObserver`。这些依赖尚无已证明等价的无Vue替代；它们不用于发送、历史读取或补聊天气泡。“无DOM点击自动化”不等于“无任何Vue/DOM依赖”。C3/C4现行范围的证据与本轮运行结果见[开发说明](docs/DEVELOPMENT.md#c3-逐类媒体证据收口)和[启动记录](docs/KK9-STARTUP.md#c4-最终构建入口只读验收)。
- 原生发送不承诺当前客户端立即显示新气泡；不通过切窗口或伪造Vue刷新掩盖差异。`unknown` 只查询原意图，不直接重发。
- `pnpm verify` 从 `@kairo/driver` 的构建后ESM入口运行授权双目标只读烟测，先运行 `pnpm build`（或已有成功的 `pnpm check`）；不会自动构建或发送。环境与输出范围见启动说明。

开发规范见 [DEVELOPMENT.md](docs/DEVELOPMENT.md)，真机检查见 [KK9-STARTUP.md](docs/KK9-STARTUP.md)。
