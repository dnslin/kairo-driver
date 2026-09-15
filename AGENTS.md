# Kairo Driver 仓库代理指南

所有交流、日志和代码注释使用中文。

## 范围

本仓库仅维护 `@kairo/driver`。修改前读取：

- 开发与验证：`docs/DEVELOPMENT.md`
- 真实 KK9 启动：`docs/KK9-STARTUP.md`

## 边界

- Driver 只负责 KK9 的 CDP 连接、运行时桥接、消息规范化和 I/O。
- Driver 不承担 Agent、Memory、数据库、知识库、审批或业务编排职责。
- 源码、测试和真机示例分别位于 `src`、`tests`、`examples`。
- 行为变化必须同步更新 `tests`，并运行相关测试及 `pnpm check`。
- 涉及真实 KK9 行为的修改必须通过对应真机脚本验证；没有真实环境时应明确记录未验证项，不把替身测试当作真机验收。
- 真实消息发送、撤回和会话操作只能在已获授权的账号与目标范围内执行，保留脚本现有的身份核对和确认门禁。
