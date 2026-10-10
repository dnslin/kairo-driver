# 按工号发送文本实施计划

## 目标与契约

在 `feature/send-text-to-user` 实现 `sendTextToUser(loginName, text, options?: SendToUserOptions): Promise<SendResult>`。`loginName` 是精确 `login_name`，不是显示名、UID或会话名称；仅去掉首尾空白。选项只含 `operationId` 和 `verifyTimeoutMs`。成功返回正式 `sessionId`、`messageId` 和既有业务回执，Driver 提供绑定正式会话的 `recall()`。原有按会话和媒体接口不变。

当前包未发布，没有已确认的外部数据迁移或滚动部署约束。不增加兼容层、依赖、批量调度、重试或空会话创建接口。

## 已有证据与决策

- 已授权账号5761/0123040139到3583/int2023，原生首条发送成功创建816219，消息137621731/索引1。
- `getUsersByLoginNames` 实测内部错误，可见组织没有匹配；直接采用实测可用的 `unionSearch(type:user)` 分页精确匹配，再读取目标档案核对。
- `getSessionInfo6` 对首次目标返回610，不把它当创建接口，不对此错误增加静默回退。
- 按人员发送使用原版 `sessionType:0/sessionID:0/receiver:UID`，由服务端解析或建立私聊。零只存在于原生首次提交，不作为公开会话ID。
- 回执必须关联本次负草稿和真实登录/接收对象；正式会话由成功业务回执取得。现有事件桥需识别尚无正式会话ID的在途发送，防止早到回显丢失SDK关联。
- 发送意图先声明，指纹区分工号与会话目标。重复和unknown只查既有业务证据；状态查询不再次找人或提交。

## 实施切片

1. **协议回归**：扩展原生IPC测试底座，新增首次会话分配、已有私聊复用、错回执/业务失败/人员查询错误、重复/失联/取消、早到实时回显行为回归。执行生成的实际脚本，不写源码字符串自证。
2. **核心路径**：新增类型/Driver/Bridge入口，扩展操作指纹与正式sessionId保存，按工号查询与权限检查、动态回执会话关联、只读状态恢复及必要事件关联。
3. **Fake与真机示例**：Fake按注入档案定位准确人员，成功建立或复用模拟私聊，不从发送请求制造消息历史；专项示例保留账号与目标确认门禁，只发送一次。
4. **验收与说明**：专项回归、新接口真机烟测、审查和 `pnpm check`；更新README、开发和启动说明。

## 验收标准

- 不依赖可见会话、编辑器或切窗口；准确工号目标可首次发送，sent包含正式sessionId。
- 人员不存在/重名歧义/档案不符/原生查询或权限失败时无草稿、无发送，错误保留方法和原生原因。
- 原生业务失败不判sent；本次负草稿、接收对象与正式会话不符不得确认；unknown不重发。
- 同一operationId并发/重复只提交一次；换工号或内容冲突拒绝；丢响应后查询可恢复本次已采集回执。
- 首条回显两种到达顺序均保持正确方向、正式会话与sdkSendKey，退出只释放自身资源。
- Fake契约一致，现有按会话发送和媒体回归不被破坏。

## 验证命令与边界

- `pnpm exec vitest run tests/native-user-text-sdk.test.ts tests/native-text-sdk.test.ts tests/event-bridge-lifecycle.test.ts tests/fake-driver.test.ts tests/send-operation.test.ts`
- `pnpm check`
- 新专项示例通过SDK入口向已授权int2023发送一条；重复operationId和状态查询不得增加提交，正式历史/目标/退出逐项核对。

int2023已被上一轮首次测试建会话，本轮SDK验收只能证明按工号复用及动态会话路径。真正首次建会话复用本轮前序原生实测及必要协议回归，不删除数据库或冒充新目标。接收端显示、通知、已读未经人工确认不能记为通过。不运行已知无关的测试全量类型检查。实施验收阶段不自动提交或推送；后续按用户明确要求提交、推送并创建PR，不自动合并或发布。
