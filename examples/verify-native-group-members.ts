import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { BridgeOrgOps, CdpClient, callIpcToData } from '@kairo/driver';

// 构建后运行；参数：登录UID 登录账号 群原生会话ID 群receiverID 群精确名。
const args = process.argv.slice(2);
const [uid, login, sessionId, receiverId, groupName] = args;
const cdp = new CdpClient({
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
});
// 与Driver门面使用相同公开实现；只读查询不需要安装或接管聊天事件桥。
const ops = new BridgeOrgOps(cdp);
const failures: Array<{ 阶段: string; 代码: string | number | null; 原因: string }> = [];
const report: Record<string, unknown> = {
  入口: '@kairo/driver → dist/index.js → BridgeOrgOps.getGroupMembers',
  开始时间: new Date().toISOString(),
  通过: false,
  保存完整成员资料或聊天正文: false,
  可见范围: 'KK9原生返回的全员与可见档案，不保证服务器最新名单或事务快照',
  本轮安装聊天事件桥: false,
  错误: failures,
};

interface SessionSnapshot {
  id: string;
  type: number;
  typeID: string;
  maxMessageIndex: number | null;
  userReadIndex: number | null;
}
interface QuerySurface {
  windowObserved: boolean;
  windowId: string | null;
  messageListeners: number;
  dataReplyListeners: number;
  driverHook: boolean;
  hookGeneration: string | null;
  hookConnection: string | null;
  nativeObserver: boolean;
  nativeBinding: boolean;
  pendingSends: number;
}
interface QuerySnapshot extends QuerySurface {
  sessions: SessionSnapshot[];
  group: SessionSnapshot;
}

let stage = '参数校验';
let connectionError: Error | undefined;
let before: QuerySnapshot | undefined;
let compared = false;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fail(error: unknown, phase = stage): void {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  const entry = {
    阶段: phase,
    代码: typeof code === 'string' || typeof code === 'number' ? code : null,
    原因: error instanceof Error ? error.message : String(error),
  };
  failures.push(entry);
  process.exitCode = 1;
  console.error(`群成员验收失败（${phase}）：${entry.原因}`);
}

cdp.on('error', (error: unknown) => {
  connectionError = error instanceof Error ? error : new Error(String(error));
  fail(connectionError, '独立CDP错误事件');
});

async function query(method: string, parameters: unknown[] = []): Promise<unknown> {
  if (connectionError) throw connectionError;
  stage = `独立原生查询：${method}`;
  const response = await callIpcToData(cdp, method, parameters);
  if (response.code !== 0) {
    throw Object.assign(new Error(`${method}（${response.code}）：${response.error || response.message || '原生未提供原因'}`), { code: response.code });
  }
  return response.data;
}

function record(value: unknown, context: string): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), `${context}不是有效对象`);
  return value as Record<string, unknown>;
}

function nativeId(value: unknown, context: string): string {
  check((typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value)) &&
    Number.isSafeInteger(Number(value)) && Number(value) > 0, `${context}不是有效正安全整数`);
  return String(Number(value));
}

function profileText(value: unknown, context: string): string | null {
  if (value == null) return null;
  check(typeof value === 'string', `${context}不是字符串`);
  return value.trim() ? value : null;
}

function sessionIdentity(value: unknown): SessionSnapshot {
  const row = record(value, '原生会话行');
  check(typeof row['type'] === 'number', '原生会话类型无效');
  const maxIndex = row['maxMessageIndex'];
  const readIndex = row['userReadIndex'];
  check(maxIndex == null || (typeof maxIndex === 'number' && Number.isSafeInteger(maxIndex)), '原生最大索引无效');
  check(readIndex == null || (typeof readIndex === 'number' && Number.isSafeInteger(readIndex)), '原生已读索引无效');
  // 仅保留身份与索引，不保存会话名、lastMessage或聊天正文。
  return {
    id: nativeId(row['id'], '原生会话ID'),
    type: row['type'],
    typeID: nativeId(row['typeID'], '原生接收对象ID'),
    maxMessageIndex: maxIndex ?? null,
    userReadIndex: readIndex ?? null,
  };
}

async function snapshot(): Promise<QuerySnapshot> {
  stage = '独立观察窗口与资源';
  // Vue只用于独立观察窗口，不作为成员、档案、群身份或索引的数据源。
  const surface = await cdp.evaluate<QuerySurface>(`(() => {
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
    const hook = window.__kairo_bridge_cleanup;
    return {
      windowObserved: !!editor,
      windowId: editor?.activedSes ? String(editor.activedSes.id) : null,
      messageListeners: ipc.listenerCount('message'),
      dataReplyListeners: ipc.eventNames().filter(name => typeof name === 'string' && /^data-\\d+$/.test(name))
        .reduce((total, name) => total + ipc.listenerCount(name), 0),
      driverHook: typeof hook === 'function',
      hookGeneration: hook?.generationId ?? null,
      hookConnection: hook?.connectionId ?? null,
      nativeObserver: typeof window.__kairo_native_send_observer === 'function',
      nativeBinding: typeof window.__kairo_native_bridge === 'function',
      pendingSends: window.__kairo_pending_sends?.size || 0,
    };
  })()`);
  check(surface.windowObserved, '无法独立观察窗口，不能证明未切换窗口');
  const conversations = record(await query('getConversations'), '原生会话列表');
  const sessionRows = conversations['sessionsInfo'];
  check(Array.isArray(sessionRows), '原生sessionsInfo未返回会话数组');
  const rows: unknown[] = sessionRows;
  const sessions = rows.map(sessionIdentity).sort((a, b) => a.id.localeCompare(b.id));
  const rawGroup = record(await query('getSessionBySessionID', [Number(sessionId)]), '授权群会话');
  const group = sessionIdentity(rawGroup);
  check(group.id === sessionId && group.type === 1 && group.typeID === receiverId, '授权群会话ID、type1或receiverID不符');
  check(rawGroup['typeName'] === groupName, '授权群精确名不符，不能换用同名其他群');
  check(group.maxMessageIndex !== null && group.userReadIndex !== null, '授权群缺少消息或已读索引');
  return { ...surface, sessions, group };
}

try {
  check(args.length === 5 && uid && login && sessionId && receiverId && groupName,
    '参数：登录UID 登录账号 群原生会话ID 群receiverID 群精确名；仅在已授权范围运行');
  nativeId(uid, '登录UID');
  nativeId(sessionId, '群原生会话ID');
  nativeId(receiverId, '群receiverID');
  report['指定范围'] = { 登录UID: uid, 群原生会话ID: sessionId, 群receiverID: receiverId };
  stage = '连接独立CDP';
  await cdp.connect();
  const identity = record(await query('getMemberDetail'), '原生实际登录档案');
  check(nativeId(identity['id'], '登录UID') === uid && identity['login_name'] === login, '实际登录身份与指定账号不符');
  before = await snapshot();
  report['查询前快照'] = before;
  stage = '构建入口getGroupMembers';
  const members = await ops.getGroupMembers(sessionId);
  const nativeMembers = await query('getGroupsAllMembers', [Number(receiverId)]);
  check(Array.isArray(nativeMembers), '独立原生全员查询未返回数组');
  const nativeRows: unknown[] = nativeMembers;
  const expectedIds = [...new Set(nativeRows.map(member => nativeId(record(member, '群成员')['id'], '群成员UID')))];
  assert.deepEqual(members.map(member => member.id), expectedIds, '全员UID、去重或原生顺序不一致');
  const nullFields = { loginName: 0, name: 0, departmentPaths: 0, position: 0 };
  let pathCount = 0;
  for (const member of members) {
    const profile = record(await query('getMemberDetail', [Number(member.id)]), '独立成员档案');
    check(nativeId(profile['id'], '独立档案UID') === member.id, '独立成员档案错人');
    check(member.loginName === profileText(profile['login_name'], '工号'), '工号与真实login_name不一致');
    check(member.name === profileText(profile['name'], '姓名'), '姓名与真实name不一致');
    check(member.position === profileText(profile['pos'], '岗位'), '岗位与真实pos不一致');
    const departments = await query('getAllDeptPaths', [Number(member.id)]);
    check(Array.isArray(departments), '独立部门查询未返回数组');
    const departmentRows: unknown[] = departments;
    const paths = new Set<string>();
    for (const department of departmentRows) {
      const chain = record(department, '部门链')['deptPaths'];
      check(Array.isArray(chain), '部门链未返回deptPaths数组');
      const nodes: unknown[] = chain;
      const names = nodes.map(node => {
        const name = record(node, '部门节点')['name'];
        check(typeof name === 'string' && name.trim(), '部门节点名称缺失');
        return name;
      });
      if (names.length) paths.add(names.join(' / '));
    }
    assert.deepEqual(member.departmentPaths, paths.size ? [...paths] : null, '全部可见部门链与真实缺失null不一致');
    pathCount += paths.size;
    for (const field of ['loginName', 'name', 'departmentPaths', 'position'] as const) {
      if (member[field] === null) nullFields[field]++;
    }
  }
  if (connectionError) throw connectionError;
  compared = true;
  report['核对摘要'] = {
    成员数: members.length, 原生原始成员行数: nativeRows.length,
    五字段逐项一致: true, UID去重且原生顺序一致: true,
    真实缺失null字段数: nullFields, 可见部门链数: pathCount,
  };
} catch (error) {
  if (error !== connectionError) fail(error);
} finally {
  if (before && cdp.getStatus() === 'connected') {
    try {
      const after = await snapshot();
      report['查询后快照'] = after;
      stage = '核对只读不变量';
      assert.deepEqual(after, before, '窗口、会话索引、监听或已有桥接资源发生变化');
      report['窗口索引监听与已有桥接均不变'] = true;
    } catch (error) { fail(error); }
  } else if (before) {
    fail(new Error('连接失效，无法核对查询后状态'), '只读不变量');
  }
  try { await cdp.disconnect(); } catch (error) { fail(error, '独立CDP退出'); }
  report['连接退出'] = cdp.getStatus();
  if (cdp.getStatus() !== 'disconnected') fail(new Error('独立CDP未断开'), '连接退出');
  report['结束时间'] = new Date().toISOString();
  report['通过'] = compared && failures.length === 0;
  try {
    await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
    await writeFile(new URL('../tmp/group-members-live-evidence.json', import.meta.url), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { fail(error, '保存群成员验收证据'); }
}
