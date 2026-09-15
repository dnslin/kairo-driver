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

## 依赖与打包

提交并保留 `pnpm-lock.yaml`、`pnpm-workspace.yaml` 和 `patches`。两条音频依赖补丁属于运行所需配置，升级相关依赖时需重新核对补丁及语音处理行为。

`pnpm pack` 会先构建再生成安装包；本仓库尚未发布 npm 包。pnpm 的补丁设置由消费项目根目录控制，不会因安装此包自动传播。需要把安装包用于其他项目时，在该项目配置对应补丁，并在仅安装生产依赖的环境检查 ESM 导入和实际使用的音频能力。
