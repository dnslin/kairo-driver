# KK9 客户端启动与真机检查

## 启动客户端

先完全退出原有 KK9，在 Windows PowerShell 中执行，路径替换为实际安装位置：

```powershell
& "C:\Path\To\KK9.exe" `
  --remote-debugging-address=127.0.0.1 `
  --remote-debugging-port=9222
```

也可以使用仓库根目录的 `start-kk9-cdp.bat`。CDP 只绑定回环地址；端口被占用时，应先确认占用进程。登录后保持主界面加载完成，需要 DOM 操作时不要最小化窗口。

打开 `http://127.0.0.1:9222/json`，应看到包含 `type: "page"`、页面 `url` 和 `webSocketDebuggerUrl` 的目标。脚本默认匹配 URL 中的 `renderer.html`，需要调整时在同一终端设置：

```powershell
$env:CDP_URL = "http://127.0.0.1:9222"
$env:PAGE_MATCH = "renderer.html"
```

`PAGE_MATCH` 必须使用实际目标 URL 中稳定的片段。不要把客户端凭据写入仓库。

## 基本诊断

在仓库根目录运行：

```bash
pnpm diagnose status
pnpm diagnose sessions
pnpm diagnose listen
```

`status` 探测 CDP，`sessions` 读取会话，`listen` 监听真实消息。`pnpm diagnose` 可查看完整命令；发送、撤回、切换等命令会实际操作客户端，需明确提供已获授权的目标。

身份、会话和十条历史的只读 SDK 验收（参数依次为登录 UID、登录账号、原生会话 ID、对端 UID、对端账号）：

```bash
pnpm exec tsx examples/verify-native-readonly.ts <登录UID> <登录账号> <原生会话ID> <对端UID> <对端账号>
```

该脚本保留实际登录与目标核对，不发送、撤回、切换、创建会话、标记已读或插入草稿。修改后的 SDK 历史与原生消息 ID、索引逐条对照，读取前后检查已读索引不变，检查没有重放实时事件；只输出必要元数据，不输出聊天正文。原生查询无需恢复或激活聊天窗口；客户端内部可能刷新档案、头像及历史资源缓存。

设备字段证据：KK9 9.0.1 的 `insertSendBefoeMsg` 直接复制参数 `deviceID`；jshookmcp 源码及真实 `message` 表确认该列允许 NULL，草稿可省略此字段。正式 `sendMessageNew` 的核心发送函数从 `CORE_DATA.deviceID` 写入当前注册设备，注册来源为 `DeviceManager.registerDevice`。SDK不填空值、不读Vue或旧消息冒充设备；T03真实正式记录已核对设备33039。`getMemberDetail()` 不提供设备字段，也未发现专用只读getter。

前序 T01/T02 真机只读验收：账号0123040139（UID5761），int2024（UID3585）的原生私聊716791；SDK与jshookmcp原生对照一致，十条消息索引651–660，读取前后userReadIndex均为660。该轮没有真实新入站、发送、撤回、群聊或媒体验收。必要元数据记录在 `tmp/kk9-t01-t02-validation.json` 和 `tmp/kk9-t02-mcp-evidence.json`。

`pnpm verify` 按指定原生私聊、群聊 ID 读取最近消息并查询员工档案，不再为历史切换窗口，不发送消息。运行前设置：

```powershell
$env:KK9_TEST_PRIVATE_ID = "<私聊会话 ID>"
$env:KK9_TEST_GROUP_ID = "<群聊会话 ID>"
$env:KK9_TEST_USER_ID = "<员工 UID>"
pnpm verify
```

## 六项修正专项回归

`examples/verify-native-regressions.ts` 核对登录身份与既有私聊，再检查原生历史、当前会话、真实发送回显、撤回事件去重、历史撤回状态和轮询隔离。运行前取得目标私聊授权，并保留与 `e2e:stage1` 相同的确认门禁：

```powershell
$env:KK9_STAGE1_CONFIRM = "<登录UID>:<对端UID>:<原生会话ID>"
pnpm exec tsx examples/verify-native-regressions.ts <登录UID> <登录账号> <原生会话ID> <对端UID> <对端账号>
```

脚本先验证历史读取不改变已读索引、不重放事件；随后必要时切换到授权目标，发送一条唯一标记的测试文本并撤回，只清理本轮本人消息，不重发未知结果。两次真实轮询采集均等待完成，不启用自动切换或调度计时器；退出时清理 Driver Hook。必要元数据和失败上下文保存到 `tmp/pr1-fix-live-evidence.json`，不输出聊天正文。空身份、可见列表缺席和 C/D 后缀等边界由自动回归覆盖，不在真机伪造登录或数据库状态。

本轮六项修正验收：`pnpm check` 的30个测试文件、394条测试通过，针对性9个文件、223条测试通过。授权账号与目标仍为5761 → int2024（3585），原生私聊716791；两次运行分别发送并撤回消息137431259、137432159，每次只派发一条正确范围的撤回事件。原记录仍为text且isRecalled为true，撤回通知保持自身ID，历史读取无重放且已读索引不变，两次等待完成的真实轮询采集均不重放撤回。两条测试消息均已撤回；最终退出无运行异常诊断。首次计时轮询运行的退出诊断保留于 `tmp/pr1-fix-live-timer-evidence.json`，最终结果见 `tmp/pr1-fix-live-evidence.json`。本轮没有员工新入站、群聊或媒体验收。

## T03 原生文本专项验收

```powershell
$env:KK9_REAL_TEST_CONFIRM = "<登录UID>:<私聊原生ID>:<群原生ID>"
$env:KK9_STAGE1_CONFIRM = "<登录UID>:<对端UID>:<私聊原生ID>"
pnpm exec tsx examples/verify-native-text.ts <登录UID> <登录账号> <私聊原生ID> <对端UID> <对端账号> <群原生ID> <群接收对象> <群精确名>
```

脚本重新核对实际登录身份、私聊对端档案、群精确名称/类型/原生ID/接收对象，双门禁都通过才操作。本轮登录0123040139（UID5761）；int2024（UID3585），原生私聊716791；群测试123，原生会话793803、接收对象29467、nativeType1。原生查询发现另一个同名群716827/26519；用户明确选择793803，未对716827发送。

只发授权两目标内最少文本及一条私聊断线边界文本，不发媒体、不改权限、不建会话、不全局断网。每个目标在显示另一授权会话时发送，记录发送前后窗口、负草稿与正式ID/索引、真实业务回执、身份范围、操作ID防重及只读查询不增加记录。断线仅关闭本轮Driver的CDP连接，等远端本轮采集结束后清旧Hook，以共享Store创建新Driver查询，绝不重发unknown。

T03证据来自jshookmcp核对的原版协议：回执通道为 `sessionType-receiver-sendMsgCallback`，`args` 是对象，`msgID` 为负草稿ID；上传失败码-9，普通失败为非0回执码，禁发617可出现在 `code:0` 且正式正ID记录的 `data.ext.status` 中。617、普通服务器业务失败与上传失败只做确定性协议回归，未在真机制造；本轮不改变成员权限或向未授权对象发送来触发错误。

每次结束按本轮operationId和发送者核对正式记录，仅撤回本轮本人消息并确认C/D原生撤回标记。专项采集会在聊天组件切换后只重挂自己被移除的监听；退出只移除自身采集与Hook。原生文本无需切窗口也能提交；客户端窗口通知仍可能取决于原生组件订阅，本轮不加DOM操作掩盖显示差异，现有撤回用于清理不等于完成T05。最新结果存于 `tmp/t03-live-evidence.json`，协议元数据为 `tmp/t03-protocol-evidence.json`，均不保存正文或凭据。

### PR 初始验收（四项修复前）

最终T03验收：相关15个文件201条回归通过；`pnpm check` 的build/typecheck、32个文件363条测试及lint通过。实际运行命令：

```cmd
cmd /c "set KK9_REAL_TEST_CONFIRM=5761:716791:793803&& set KK9_STAGE1_CONFIRM=5761:3585:716791&& pnpm exec tsx examples/verify-native-text.ts 5761 0123040139 716791 3585 int2024 793803 29467 测试123"
```

最终运行ID：`388017e3-456a-4312-a989-2860b21a5747`。所有草稿为-26，回执code0且无业务失败，正式设备33039；正式记录与独立回执逐条关联：

| 场景        | 原生会话 | 正式ID    | 索引 | 结果                     | 清理   |
| ----------- | -------- | --------- | ---- | ------------------------ | ------ |
| int2024私聊 | 716791   | 137443977 | 673  | sent                     | 已撤回 |
| 测试123群聊 | 793803   | 137443981 | 113  | sent                     | 已撤回 |
| 提交后断线  | 716791   | 137443985 | 674  | unknown → 新实例查询sent | 已撤回 |

私聊发送前后都显示793803，群聊发送前后都显示716791；每个意图仅一次原生提交，重复调用与查询无新增。退出后本轮采集/DriverHook均无残留，在途发送0；未真机触发617、普通服务器业务失败或上传失败，未发送媒体。额外测试/示例类型检查仍只剩既有库目标、Buffer与数组可空诊断，不能写作全量类型通过。

失败尝试也保留证据：第一次业务回执包装错误导致unknown，137439705已撤回；第二次群SDK确认sent但专项采集监听在窗口切换时被KK9移除，137439983/137439987已撤回。修正采集后第三次通过，137440701/137440703/137440707已撤回，记录为 `tmp/t03-third-live-evidence.json`；前两次为 `tmp/t03-first-live-failure.json`、`tmp/t03-second-live-failure.json`，不把它们记为通过。本轮九条本人测试消息全部清理，无需用户手动撤回。T04/T05/C2及媒体任务未验收或提前勾选。

### 合并前四项修复验收

重新使用上述双门禁命令运行修改后的 SDK，运行ID `0357111b-c8ee-4afd-9a4e-285cd76d9069`。jshookmcp 独立核对原生登录UID5761、既有两目标及 AbortController/abort 监听API可用；仍只操作716791和793803，不操作同名群716827。所有回执草稿-26、code0、无业务失败，正式设备33039：

| 场景        | 原生会话 | 正式ID    | 索引 | 结果                     | 清理   |
| ----------- | -------- | --------- | ---- | ------------------------ | ------ |
| int2024私聊 | 716791   | 137475067 | 677  | sent                     | 已撤回 |
| 测试123群聊 | 793803   | 137475321 | 115  | sent                     | 已撤回 |
| 提交后断线  | 716791   | 137475471 | 678  | unknown → 新实例查询sent | 已撤回 |

三个意图各提交一次，重复与查询无新增；私聊前后窗口793803，群前后窗口716791。三条本轮本人消息全部撤回并核对原生标记；专项采集无残留、在途0、DriverHook无残留，jshookmcp后验一致，两业务通道监听数分别1和0，与本轮基线一致。没有真实触发慢回执、取消竞态、617、普通服务器失败或上传失败；它们由确定性的执行生成脚本回归覆盖，不改权限、不发媒体或全局断网制造故障。

`pnpm check` 的build/typecheck、32个文件381条测试及lint通过；额外测试/示例全量类型检查仍未通过，仅有已记录的三个无关测试文件诊断。最新真机结果为 `tmp/t03-live-evidence.json`；初始PR最后一轮证据先保留为 `tmp/t03-initial-live-evidence.json`，没有抹除上述历史尝试。T04/T05/C2仍未验收。

## 私聊与群聊回归

`pnpm e2e` 会真实发送文本、富文本、文件、图片和引用回复，切换会话、标记已读，并尝试撤回测试消息。先取得测试账号和会话的使用授权，再设置实际值：

```powershell
$env:KK9_TEST_USER_ID = "<登录 Bot UID>"
$env:KK9_TEST_PRIVATE_ID = "<私聊会话 ID>"
$env:KK9_TEST_PRIVATE_NAME = "<私聊会话名称>"
$env:KK9_TEST_GROUP_ID = "<群聊会话 ID>"
$env:KK9_TEST_GROUP_NAME = "<群聊会话名称>"
$env:KK9_REAL_TEST_CONFIRM = "$($env:KK9_TEST_USER_ID):$($env:KK9_TEST_PRIVATE_ID):$($env:KK9_TEST_GROUP_ID)"
pnpm e2e
```

脚本会核对实际登录用户以及私聊、群聊的 ID、名称和类型。确认值缺失或不匹配时停止后续副作用；不要通过删除校验来运行测试。

## 消息方向与发送状态验证

`pnpm e2e:stage1` 使用真实 Driver 验证入站方向、Bot 回显、重复消息、发送状态和操作 ID 防重。先配置授权的私聊：

```powershell
$env:KK9_STAGE1_BOT_UID = "<登录 Bot UID>"
$env:KK9_STAGE1_EMPLOYEE_UID = "<目标员工 UID>"
$env:KK9_STAGE1_SESSION_ID = "<原生私聊会话 ID>"
$env:KK9_STAGE1_SESSION_NAME = "<目标员工会话名>"
$env:KK9_STAGE1_CONFIRM = "$($env:KK9_STAGE1_BOT_UID):$($env:KK9_STAGE1_EMPLOYEE_UID):$($env:KK9_STAGE1_SESSION_ID)"
pnpm e2e:stage1
```

运行后按终端提示，由目标员工发送真实消息。脚本覆盖 `sent`、确定发生在发送前的 `failed`、发送后的 `unknown` 和重新连接后的状态查询。它会尝试撤回测试消息，清理失败时汇总未撤回的原生消息 ID。

若历史中没有可用的非系统 `unknown` 消息，脚本会去除真实消息中的身份字段进行受控验证；这部分只能证明证据不足时保留 `unknown`，不能代替真实员工入站和 Bot 回显验收。

## 卡片与语音验证

```powershell
$env:KK9_MEDIA_TARGET_ID = "<目标会话 ID>"
$env:KK9_MEDIA_TARGET_NAME = "<目标会话名称>"
$env:KK9_MEDIA_CONFIRM = "<登录 Bot UID>:$($env:KK9_MEDIA_TARGET_ID):$($env:KK9_MEDIA_TARGET_NAME)"
pnpm e2e:media
```

该脚本会发送链接、业务、应用、合并转发卡片和合成语音，核对原生历史，并默认尝试撤回。只检查某种类型时可追加参数，例如 `pnpm e2e:media UrlCard`。语音合成需要连接外部 TTS 服务；设置 `KK9_MEDIA_AUDIO_FILE` 可增加本地音频用例。只有需要保留测试消息时才设置 `KK9_MEDIA_KEEP=1`。

## 排障与退出

| 现象                 | 检查方式                                       |
| -------------------- | ---------------------------------------------- |
| CDP 拒绝连接         | 确认 KK9 由带调试参数的命令启动，旧实例已退出  |
| 找不到目标页面       | 查看 `/json`，确认 `PAGE_MATCH` 匹配页面 URL   |
| DOM 操作失败         | 恢复窗口，确认页面已加载、目标会话正确         |
| Driver 失效          | 清理原实例并创建新实例，不能对失效实例原地重连 |
| 消息状态为 `unknown` | 保留原 `operationId` 查询，不直接重发          |

结束时先退出验证脚本，再关闭带调试参数启动的 KK9。没有实际 KK9 环境时，只运行自动检查并注明真机验收尚未执行。
