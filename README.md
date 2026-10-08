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

消息事件包含 `inbound`、`outbound` 和 `unknown` 方向。接入 Bot 时只把确认的入站消息交给上层，避免响应自己发出的消息。消息类型、提及、引用及附件字段见 [类型定义](src/types/index.ts)。

## 原生身份与会话

`getCurrentUserId()` 使用无参数原生 `getMemberDetail()` 取得实际登录 UID；`connect()` 也使用该身份，不以配置值代替登录账号。`getSessions()` 使用原生 `getConversations()`，不读取聊天窗口。空会话返回 `[]`，查询失败抛出保留方法、错误码与诊断的 `DriverError`，不会回退 DOM。

会话 `id` 是原生 `sessionID` 的字符串形式；`receiverId` 是私聊对端 UID，其他类型为原生 `typeID`；`nativeType` 保留原生类型数字。`type` 区分 `private`、`group`、`discussion`、`service` 和 `unknown`。原生会话列表不提供窗口 `active` 状态。

例如原生会话 `716791` 的对端 UID 是 `3585`；界面事件标识 `0-3585` 不是公开会话 ID。发送、撤回和窗口操作使用 `getSessions()` 返回的 `id`。`getEmployeeBySession()` 接受原生会话 ID 或会话实体；查询 UID 请使用 `getUserProfile()`。窗口接口暂保留，不能把窗口状态当作原生查询的数据来源。

## 指定会话读取历史

`getRecentMessages(session, limit = 20)` 必须传入 `getSessions()` 返回的会话实体，直接把其原生 `id` 传给 `getMessages`，不默认当前聊天，不按名称猜测目标，也不回退可见消息气泡。

```ts
const session = (await driver.getSessions()).find(item => item.id === nativeSessionId);
if (!session) throw new Error('未找到指定原生会话');
const history = await driver.getRecentMessages(session, 10);
```

`id` / `messageId` 是原生消息 ID，`msgIdx` 是原生消息索引，两者不能互换。历史保留原生撤回状态和系统记录，不派发 `message`、`at` 或 `recalled` 实时事件。空页返回 `[]`，原生失败或无效回包抛错；SDK 不猜测补页或自动重试。原生客户端内部可能补取历史并更新本地缓存；读取不会切换会话或标记已读。

这里只切换主动历史读取；现有自动轮询和补偿扫描的窗口操作尚未在本轮移除，不应将它们用于只读验收。

## 发送消息

发送必须提供 `getSessions()` 返回的原生 `targetSessionId`；缺省、界面标识或会话名称均不会改投当前窗口。文本直接读取原生身份与指定会话，预插入草稿、订阅本次业务回执后提交，不读聊天编辑器、按钮或 Vue。下面的函数使用上例中已连接的 `driver`，只有调用函数时才会发送：

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

还支持图片、文件、富文本、引用回复、卡片、语音和撤回；完整方法见 [IKK9Driver](src/types/index.ts)。图片和文件路径属于运行 Driver 的机器，跨机器接入时由调用方传输实际文件。

## 运行边界

- KK9 必须保持登录，CDP 端口只绑定 `127.0.0.1`。
- Driver 失效或调用 `disconnect()` 后，需要创建新实例再连接。调用方负责监听 `health`、恢复连接和安排重试；Kairo 应用原有的连接监督器没有包含在本包中。
- Driver 依赖 KK9 客户端内部接口，客户端升级后需要验证相关收发能力。
- `pnpm test` 是自动测试，不连接真实 KK9。真机命令会读取客户端数据，部分命令还会发送消息或切换会话，操作范围见启动说明。

开发规范见 [DEVELOPMENT.md](docs/DEVELOPMENT.md)，真机检查见 [KK9-STARTUP.md](docs/KK9-STARTUP.md)。
