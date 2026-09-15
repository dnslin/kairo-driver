# Kairo Driver

面向 KK9 桌面客户端的 TypeScript Driver，通过本机 CDP 连接客户端，提供消息收发、会话管理和组织架构查询。

从 [Kairo](https://github.com/dnslin/kairo) 的 `packages/driver` 独立而来，保留包名 `@kairo/driver` 和现有 API。它是客户端 SDK，需要已登录的 KK9；不包含 Bot 服务、模型调用、知识库或 AstrBot 适配器。

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

## 发送消息

发送时明确指定 `targetSessionId`。下面的函数使用上例中已连接的 `driver`，只有调用函数时才会发送：

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

`unknown` 表示尚不能确认结果，消息可能已经送达；查询后仍可能是 `unknown`，不要当作确定失败重发。同一个发送意图应复用 `operationId`。默认发送记录保存在内存，跨实例或进程恢复需要调用方提供相应的 `SendOperationStore`。

还支持图片、文件、富文本、引用回复、卡片、语音和撤回；完整方法见 [IKK9Driver](src/types/index.ts)。图片和文件路径属于运行 Driver 的机器，跨机器接入时由调用方传输实际文件。

## 运行边界

- KK9 必须保持登录，CDP 端口只绑定 `127.0.0.1`。
- Driver 失效或调用 `disconnect()` 后，需要创建新实例再连接。调用方负责监听 `health`、恢复连接和安排重试；Kairo 应用原有的连接监督器没有包含在本包中。
- Driver 依赖 KK9 客户端内部接口，客户端升级后需要验证相关收发能力。
- `pnpm test` 是自动测试，不连接真实 KK9。真机命令会读取客户端数据，部分命令还会发送消息或切换会话，操作范围见启动说明。

开发规范见 [DEVELOPMENT.md](docs/DEVELOPMENT.md)，真机检查见 [KK9-STARTUP.md](docs/KK9-STARTUP.md)。
