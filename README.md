# Kairo Driver

面向 KK9 桌面客户端的 TypeScript Driver，通过本地或远程 CDP 连接客户端，提供消息收发、附件传输、会话管理和组织架构查询。Driver 可运行在 Linux，KK9 继续运行在 Windows。

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

## 远程 CDP

`cdp.url` 接受可达的 HTTP/HTTPS 发现基址，例如 `http://172.16.0.18:9222`；保留路径前缀，去掉尾斜杠后追加 `/json`。不要填写 `/json`、WebSocket 地址、查询参数或片段。发现结果中的 `webSocketDebuggerUrl` 必须能从 Driver 机器访问，客户端按返回值连接，不自动改写主机、端口或 `ws/wss`。HTTPS/WSS 使用 Node 的正常证书校验。

KK9 默认只监听 Windows 回环地址；通过 SSH 隧道或限定来源的 Windows 端口转发提供访问，不把无认证的 CDP 直接开放到公网。端口转发部署已真实验证返回 `ws://172.16.0.18:9222/...`，无需重写发现地址。失效实例仍须重建，应用层重连职责不变；无需在 Windows 部署桥接、HTTP 文件服务或共享磁盘。

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

还支持图片、文件、富文本、引用回复、卡片、语音和撤回；完整方法见 [IKK9Driver](src/types/index.ts)。图片、普通文件和语音文件的输入路径均属于运行 Driver 的机器；Driver 自己传输图片和普通文件，不再要求调用方复制到 Windows。

### 跨机器图片与普通文件

| 接口 | 路径与结果语义 |
| --- | --- |
| `sendImage(imagePath, options)` | 读取 Driver 本机图片，最多 20 MiB；SDK 分块传到 KK9，再由 KK9 解码、准备原图和缩略图、上传和发送。 |
| `sendFile(filePath, options)` | 读取 Driver 本机普通文件，最多 100 MiB；SDK 分块传到 KK9，保留原文件名和扩展名，再由原生接口上传和发送。 |
| `downloadImage(image, fullPath)` | 优先读取 KK9 的准确原图缓存；只有缓存不存在才由原生接口下载准确原图，然后保存到 Driver 本机 `fullPath`。返回本机绝对路径。 |
| `saveFile(fileInfo, fullPath)` | 将 KK9 已缓存的普通附件保存到 Driver 本机 `fullPath`，返回本机绝对路径；未缓存明确抛 `DriverError(FILE_SAVE_FAILED)`，不新增普通文件下载协议。 |

`KK9ImageInfo.filePath/originalFilePath` 和 `KK9FileInfo.filePath` 属于 KK9 机器，可能是 Windows 路径；不要在 Linux 上 `resolve/stat/readFile` 这些字段。`readImageAsBase64/saveImageToFile` 仍是纯本地工具，不提供远程文件传输；跨机器消息附件使用上述 Driver 方法。

发送和接收均使用现有 CDP 连接，每块 256 KiB、串行传输、每次文件操作等待最多 10 秒，不把整份 100 MiB 文件一次编码成 Base64。Windows 临时目录由 SDK 独占创建和管理，不接受 Linux 路径作为原生文件路径。合法 Windows 文件名保持原样；无法表示的文件名会明确失败，不静默改名。

上传阶段的临时文件在 60 秒空闲后回收，每块刷新期限。原生文件操作开始后保留租约：超时、取消或 `unknown` 只停止等待，不证明 KK9 已停止读取；等实际原生完成回包才删除 SDK 临时目录。正常完成和前置失败会请求清理，清理错误保留诊断；不会删除 KK9 自身的图片缓存。原生任务永久不回包时保留文件和自身监听；客户端异常退出后可能遗留临时目录，不在其他连接中猜测并强删。

调用方先创建目标父目录。接收内容写入目标同目录的独占 `.part`，完整传输并检查长度、关闭文件后才重命名发布；失败不覆盖已有完整目标，清理本次部分文件。原图下载等待最多 30 秒；失败抛包含资源、路径和原始原因的 `DriverError(IMAGE_DOWNLOAD_FAILED)`。缓存保留期和接收附件应用大小限制仍由消费方负责。

存在独立原图字段时不读取或下载缩略图，包括原图字段显式为空的情况；只有两个原图字段均未提供时才接受单一缓存或 `uri`。`hasOriginalImageSource/getOriginalImageUri` 继续表达相同来源规则。`FakeKK9Driver.setImageResource(uri, bytes)` 注入下载资源，`setCachedFile(kkPath, bytes)` 注入缓存；保存实际字节，未注入资源明确失败。

### astrbot_plugin_kairo 接入

本节跨机器接入说明最初针对插件固定的 `8208e78b1134484f8b374edb33ee2d595e624591` / Driver 2.0.1 编写；当前文字语音修复所需的源码提交、依赖锁文件及音频补丁同步见下文语音说明。本次未修改插件仓库，也未发布新标签或 npm 包。

发送侧 `bridge/src/bridge.ts` 的 `sendImage(file)`、`sendFile(file)` 和 `sendVoice({ filePath: file })` 调用形状不变，`file` 继续是插件下载到 Linux 的文件；保持原生目标与稳定 `operationId`。接收侧 `attachments.ts` 不再对消息中的 Windows 路径做本地读取、`attachmentRoots` 扫描或路径转换：图片调用 `downloadImage`，普通文件调用 `saveFile`，成功后仍由插件上传到 AstrBot。`Pick<IKK9Driver, 'downloadImage'>` 在需要保存文件的接收入口扩为 `Pick<IKK9Driver, 'downloadImage' | 'saveFile'>`。

以下函数只取得插件本地文件，不承担 AstrBot 协议；调用方继续保留既有缓存复用、保留期、大小检查和上传逻辑：

```ts
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { IKK9Driver, KK9Message } from '@kairo/driver';

async function saveReceivedAttachments(
  driver: Pick<IKK9Driver, 'downloadImage' | 'saveFile'>,
  message: KK9Message,
  cacheDirectory: string
): Promise<{ images: string[]; file?: string }> {
  await mkdir(cacheDirectory, { recursive: true });
  const images: string[] = [];
  for (const image of message.images ?? []) {
    images.push(await driver.downloadImage(image, path.join(cacheDirectory, randomUUID())));
  }
  const file = message.fileInfo
    ? await driver.saveFile(message.fileInfo, path.join(cacheDirectory, randomUUID()))
    : undefined;
  return { images, file };
}

async function sendDownloadedFile(
  driver: IKK9Driver,
  localFile: string,
  targetSessionId: string,
  operationId: string
) {
  const result = await driver.sendFile(localFile, { targetSessionId, operationId });
  return result.status === 'unknown' ? driver.getSendStatus(operationId) : result;
}
```

接收失败应沿用插件的逐项 `attachment_error` 处理，不把不存在的本地路径当上传成功；不要仅因 `getOriginalImageUri()` 为空就提前拒绝仍有准确原图缓存的图片。普通文件未缓存时仍报告当前限制，不让插件直接调用 CDP 或猜测 KK 下载接口。

文件语音继续在 Driver 机器读取 WAV/MP3、解码和重采样，通过 CDP 传 PCM 给 Windows 的 AMR 编码器；发送内容内联携带 AMR，不改为临时上传文件，也不支持任意音频格式。文字语音由 Driver 机器访问 Edge TTS，遵循下文代理规则。跨机器附件阶段的文字 TTS 曾返回 HTTP 403；现已采用经真实合成验证的 SDK 新端点修复，见[独立文字语音验收](docs/KK9-STARTUP.md#edge-tts-403-修复与独立合成验收)。合成与编码成功不代表消息送达或接收端播放通过。

### 只读人员搜索

`searchEmployees(keyword, timeoutMs?)` 搜索当前登录账号可见人员。关键词去首尾空白，匹配规则沿用 KK9 原生搜索；Driver 内部每页200条读完，再按 UID 去重并读取真实档案和所有可见部门路径。默认整轮期限30秒，同时限制原生请求及CDP等待；空关键词、无效期限、原生失败或超时抛出 `DriverError`，不返回部分成功。

```ts
const result = await driver.searchEmployees('张三');
const candidates = result.employees.map(employee => ({
  uid: employee.id,
  name: employee.name ?? '姓名未提供',
  loginName: employee.loginName ?? '工号未提供',
  department: employee.departmentPaths?.join('；') ?? '部门未提供',
}));
```

- 返回 `{ employees, hasMore: false }`；只有原生分页全部完成才成功返回，正常无匹配返回空数组。不能把首页的一位当成唯一，也不能把模糊搜索结果或当前账号可见范围称为“全公司只有一个”。查询不是人员目录的事务快照。
- `id` 是规范化字符串 UID，同人多部门只保留一个候选；同名不同 UID 全部保留。`loginName` 仅取档案真实 `login_name`，保留大小写和前导零；姓名或工号缺失为 `null`，不用 UID 或展示回退值替代。
- `departmentPaths` 是所有原生提供的可见部门链，按祖先到叶子以 ` / ` 连接；未提供为 `null`，应显示“部门未提供”。不从职位推断，不补不可见的祖先部门。
- 搜索不创建会话、不插草稿、不发送、不标已读或派发聊天事件。Driver 不处理中文对话，不保存候选序号或用户选择；调用方负责保存“序号→UID”的映射，不按姓名绑定。缺工号时不能把 UID 当成 `sendTextToUser` 的工号。
- `FakeKK9Driver.setSearchEmployees()` 独立注入真实搜索候选，支持姓名或工号字面子串匹配，不模拟原生拼音/summary扩展；不从 `setEmployees()` 的展示字段推断真实工号。

真机专项使用构建后的公开入口，方法见 [只读人员搜索验收](docs/KK9-STARTUP.md#只读人员搜索验收)。

### 列出群全员资料

`getGroupMembers(sessionId, timeoutMs?)` 接受原生群会话 ID，返回 `KK9GroupMember[]`。不能传群接收对象 ID、群名或界面标识；内部读取会话真实群对象，再查询原生全员并按 UID 去重，不截断为200人。默认整轮期限30秒，同时约束原生与CDP等待；未知/非群会话、原生失败、无效响应、任一档案缺席/错人或超时均抛出 `DriverError`，不返回半份名单。正常空群返回 `[]`。

```ts
const members = await driver.getGroupMembers('793803');
console.table(members.map(member => ({
  ID: member.id,
  工号: member.loginName ?? '未提供',
  姓名: member.name ?? '未提供',
  部门: member.departmentPaths?.join('；') ?? '未提供',
  岗位: member.position ?? '未提供',
})));
```

- `id` 是字符串人员UID；工号、姓名和岗位分别来自准确档案的 `login_name/name/pos`，缺失为 `null`。保留工号前导零，不用群昵称、UID、其他编号或部门填充真实字段。
- `departmentPaths` 是全部原生提供的可见部门链，沿用人员搜索的 ` / ` 连接和去重规则；未提供为 `null`，不从岗位推断部门。岗位文本原样返回，不擅自拆分多个岗位。
- 名单来自 KK9 `getGroupsAllMembers` 的全部 `allUsers`，包含原生已展开的部门成员。KK9内部服务器同步失败可能继续读取本地名单，因此不保证服务器最新成员，也不是事务快照；SDK不额外添加静默回退、缓存或重试。
- 查询不发送、撤回、建会话、插草稿、标已读或切窗口，也不派发聊天事件。Fake通过 `setGroupMembers(sessionId, members)` 按群独立注入真实资料，不复用展示工号；相同UID保留首份档案并合并全部部门路径。

命令行直接列出全部五列（独立只读CDP连接，不安装或接管Driver事件Hook）：

```powershell
$env:CDP_URL = "http://172.16.0.18:9222"
pnpm diagnose group-members 793803
```

可追加整轮期限毫秒数，如 `pnpm diagnose group-members 793803 60000`。其他环境请使用实际CDP地址及获授权群会话；构建入口真机对照见 [群全员资料只读验收](docs/KK9-STARTUP.md#群全员资料只读验收)。


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

文本语音合成读取运行 Driver 的 Node 进程环境变量：优先非空 `HTTPS_PROXY`，其次非空 `HTTP_PROXY`，首尾空白会移除；两者均未配置时保持 SDK 既有直连网络行为。指定代理失败保留 `VOICE_TTS_FAILED` 及原因，不回退直连。不会自动继承 AstrBot 的代理配置，也不读取 Windows 系统代理、`ALL_PROXY` 或新增 KK 配置；Windows 下需由启动终端或服务为该 Node 进程提供环境变量，设置示例见 [语音验证](docs/KK9-STARTUP.md#卡片与语音验证)。

当前锁定 `node-edge-tts@1.2.11`，使用上游的 `api.msedgeservices.com/tts/cognitiveservices/websocket/v1` 和 `Ocp-Apim-Subscription-Key`；该发布包仍采用 Sec-MS-GEC v1，但已在现有代理下真实合成成功，并非自行实现或回放 v2 token。旧版本的超时、代理连接取消与资源关闭补丁已移植到 `patches/node-edge-tts@1.2.11.patch`。

插件当前固定 `1c4223fee51296ff68aa8f18b98d406bcdd800c8`，不含此修复。接入时将源码提交固定到包含本次修复的 Driver 提交，同步 vendor、依赖与锁文件；消费项目的 `patchedDependencies` 改为 `node-edge-tts@1.2.11` 及其新补丁，删除旧 `1.2.10` 配置，保留 `@audio/decode-wav@1.5.0` 补丁。仅升级 SDK、不移植资源清理补丁不算完整升级。准确修复 SHA 以 Git 提交记录为准；不使用现有版本号或旧提交冒充修复版本，不修改插件或生产服务。

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

- KK9 必须保持登录。默认启动只绑定 `127.0.0.1`；远程部署通过受限隧道或端口转发访问，发现返回的 WebSocket 地址必须从 Driver 机器可达。
- Driver 失效或调用 `disconnect()` 后，需要创建新实例再连接。调用方负责监听 `health`、恢复连接和安排重试；Kairo 应用原有的连接监督器没有包含在本包中。
- Driver 依赖 KK9 客户端内部接口，客户端升级后需要验证相关收发能力。
- `pnpm test` 是自动测试，不连接真实 KK9。真机命令会读取客户端数据，部分命令还会发送、撤回或标已读；必须限定授权身份与原生目标，操作范围见启动说明。
- 本机菜单撤回仍保留 `event-bridge.ts` 中已验收的Vue总线、会话撤回通知、`addRevokeMsg`及组件重建用 `MutationObserver`。这些依赖尚无已证明等价的无Vue替代；它们不用于发送、历史读取或补聊天气泡。“无DOM点击自动化”不等于“无任何Vue/DOM依赖”。C3/C4现行范围的证据与本轮运行结果见[开发说明](docs/DEVELOPMENT.md#c3-逐类媒体证据收口)和[启动记录](docs/KK9-STARTUP.md#c4-最终构建入口只读验收)。
- 原生发送不承诺当前客户端立即显示新气泡；不通过切窗口或伪造Vue刷新掩盖差异。`unknown` 只查询原意图，不直接重发。
- `pnpm verify` 从 `@kairo/driver` 的构建后ESM入口运行授权双目标只读烟测，先运行 `pnpm build`（或已有成功的 `pnpm check`）；不会自动构建或发送。环境与输出范围见启动说明。

## 未发布变更

- 修复：锁定经真实合成验证的 `node-edge-tts@1.2.11` 新服务端点，移植仍需要的超时、代理 CONNECT 取消及文件/WebSocket 清理补丁；代理优先级、KK 编码和发送防重不变。
- 验证：语音相关54项通过；独立真实 MP3 解码4.176秒，最终 Driver 经 KK9 AMR 编码/回解4.18秒、有声、无聊天操作。构建、类型检查与lint通过；全套 `pnpm check` 被已有人员搜索工作区测试的定时器断言阻断，详情见开发说明。
- 新增：`getGroupMembers` 和 `group-members` 只读列出群全部成员的ID、真实工号、姓名、全部可见部门路径和岗位；缺失字段为null，失败不返回部分名单，不保证KK9服务器最新快照。
- 新增：`searchEmployees` 只读人员搜索，内部全分页、UID去重、真实工号和所有可见部门路径；失败不返回部分结果，不负责对话或选择状态。
- 修复：人员搜索的剩余总期限同时约束CDP等待；只读专项的双连接故障进入退出流程，按本代归属清理资源，并分别保留原生首错及清理错误。
- 新增：图片和普通文件通过现有 CDP 分块传输，统一采用 Driver 本机输入路径，无需 Windows 桥接或共享磁盘。
- 修复：`downloadImage` 将准确原图保存到 Driver 本机，不再对 Windows 内部路径做宿主文件操作；新增 `saveFile` 保存已有缓存普通附件。
- 保持：本地 CDP、原图选择、发送防重及 `sent/failed/unknown` 语义；语音继续采用既有数据传输，不新增连接框架、依赖或自动重试。
- 历史验证（人员搜索阶段）：人员搜索评审修复后完整检查38文件505项通过，1项既有Linux专属用例在Windows跳过；授权真机只读专项通过。既有Linux → Windows 100 MiB文件往返、准确原图缓存保存与WAV/MP3编码结果，以及当时TTS 403、真实消息发送/原生云端原图下载及接收端播放未验收项，仍见启动说明；该阶段未重跑这些真机媒体场景。

## 2.0.1 变更记录

- 修复：文字语音合成显式使用 Node 进程的非空 `HTTPS_PROXY`，其次 `HTTP_PROXY`；无需增加 KK 专用配置或更换 TTS 引擎。
- 保持：未配置代理时继续直连，指定代理失败保留原始错误，不再尝试另一条网络路径。
- 修复：代理 CONNECT 一直不返回时，合成超时会取消代理自己的底层连接，不再留下占用句柄的 TCP 连接。
- 验证：本地 CONNECT 代理选路与错误传播回归、真实 Edge 合成及 KK9 AMR 编码/回解通过；本次未发送测试聊天消息，接收端播放仍需人工确认。
- 分发：本版本通过 GitHub 标签与源码发布，未发布到 npm；消费方应固定该版本对应的源码提交，并保留两份音频依赖补丁。


开发规范见 [DEVELOPMENT.md](docs/DEVELOPMENT.md)，真机检查见 [KK9-STARTUP.md](docs/KK9-STARTUP.md)。
