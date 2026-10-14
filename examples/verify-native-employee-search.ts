import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { CdpClient, KK9Driver, callIpcToData } from '@kairo/driver';
import type { KK9EmployeeSearchResult } from '@kairo/driver';

// 只使用已构建的公开入口；参数：登录UID 登录账号 搜索词 候选UID。
const args = process.argv.slice(2);
const [uid, login, keyword, candidateUid] = args;
const config = {
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
};
const driver = new KK9Driver({ cdp: config, rejectExistingBridge: true });
const cdp = new CdpClient(config);
const runId = randomUUID();
const realtimeEvents = { message: 0, at: 0, recalled: 0 };
const failures: Array<{ 阶段: string; 类型: string; 代码: string | number | null; 原因: string }> = [];
const report: Record<string, unknown> = {
  运行ID: runId,
  入口: '@kairo/driver → dist/index.js（已构建产物）',
  开始时间: new Date().toISOString(),
  通过: false,
  保存完整搜索资料或凭据或聊天正文: false,
  可见范围: '仅指定登录账号对指定搜索词可见的人员与部门链，不断言全公司可见或姓名唯一',
  错误: failures,
};
let stage = '参数校验';
let connected = false;
let probeAttempted = false;
let before: SearchSnapshot | undefined;
let exiting = false;
let independentError: Error | undefined;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    stage = message;
    throw new Error(message);
  }
}

function fail(error: unknown, phase = stage): void {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  failures.push({
    阶段: phase,
    类型: error instanceof assert.AssertionError ? '断言失败' : error instanceof Error ? '执行失败' : '未知失败',
    代码: typeof code === 'string' || typeof code === 'number' ? code : null,
    原因: error instanceof Error ? error.message : String(error),
  });
  report['通过'] = false;
  process.exitCode = 1;
  console.error(`人员搜索验收失败（${phase}）`, error);
}

for (const event of ['message', 'at', 'recalled'] as const) {
  driver.on(event, () => { realtimeEvents[event]++; });
}
driver.on('error', error => { fail(error, 'Driver错误事件'); });
// 独立连接没有Driver代为监听；退出期间也必须保留真实诊断，不能触发uncaughtException。
cdp.on('error', error => {
  const cause = error instanceof Error ? error : new Error(String(error));
  independentError ??= cause;
  fail(cause, '独立CDP错误事件');
});

async function awaitMain<T>(operation: () => Promise<T>): Promise<T> {
  // 只竞速当前实际操作，不把整段主流程放到后台；finally通过断开Driver终止在途搜索。
  if (exiting) return await operation();
  if (independentError) throw independentError;
  let onError!: (error: Error) => void;
  const errorSignal = new Promise<never>((_resolve, reject) => {
    onError = error => { reject(independentError ?? error); };
  });
  cdp.once('error', onError);
  try {
    return await Promise.race([operation(), errorSignal]);
  } finally {
    cdp.off('error', onError);
  }
}

async function query<T>(method: string, parameters: unknown[] = []): Promise<T> {
  stage = `独立原生查询：${method}`;
  const response = await awaitMain(() => callIpcToData<T>(cdp, method, parameters));
  if (response.code !== 0) {
    const reasons = [response.error, response.message].filter(reason => typeof reason === 'string' && reason.length > 0);
    throw Object.assign(new Error(`独立原生查询失败：${method} (${response.code}): ${reasons.join('；') || '原生未提供原因'}`),
      { code: response.code });
  }
  check(response.data !== undefined && response.data !== null, `独立原生查询缺少数据：${method}`);
  return response.data;
}

type SessionRow = {
  id: string | number;
  type: number;
  typeID: string | number;
  maxMessageIndex?: number;
  userReadIndex?: number;
};

interface SearchSurface {
  windowId: string | null;
  messageListeners: number;
  dataReplyListeners: number;
  driverHook: boolean;
  hookGeneration: string | null;
  nativeObserver: boolean;
  nativeBinding: boolean;
  pendingSends: number;
  searchProbe: boolean;
}

interface SearchSnapshot extends SearchSurface {
  sessions: Array<{
    id: string;
    type: number;
    typeID: string | number;
    maxMessageIndex: number | null;
    userReadIndex: number | null;
  }>;
}

async function snapshot(): Promise<SearchSnapshot> {
  stage = '独立观察窗口与资源';
  const surface = await awaitMain(() => cdp.evaluate<SearchSurface>(`(() => {
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
    const hook = window.__kairo_bridge_cleanup;
    return {
      windowId: editor?.activedSes ? String(editor.activedSes.id) : null,
      messageListeners: ipc.listenerCount('message'),
      dataReplyListeners: ipc.eventNames().filter(name => typeof name === 'string' && /^data-\\d+$/.test(name))
        .reduce((total, name) => total + ipc.listenerCount(name), 0),
      driverHook: typeof hook === 'function',
      hookGeneration: typeof hook?.generationId === 'string' ? hook.generationId : null,
      nativeObserver: typeof window.__kairo_native_send_observer === 'function',
      nativeBinding: typeof window.__kairo_native_bridge === 'function',
      pendingSends: window.__kairo_pending_sends?.size || 0,
      searchProbe: !!window.__kairo_employee_search_probe,
    };
  })()`));
  const conversations = await query<{ sessionsInfo?: SessionRow[] }>('getConversations');
  check(Array.isArray(conversations.sessionsInfo), '原生会话快照缺少sessionsInfo数组');
  // 严格白名单：不保存lastMessage、会话名或任何聊天正文。
  const sessions = conversations.sessionsInfo.map(row => {
    check(row && row.id !== undefined && row.type !== undefined && row.typeID !== undefined,
      '原生会话快照缺少身份字段');
    return {
      id: String(row.id),
      type: row.type,
      typeID: row.typeID,
      maxMessageIndex: row.maxMessageIndex ?? null,
      userReadIndex: row.userReadIndex ?? null,
    };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { ...surface, sessions };
}

async function installProbe(): Promise<void> {
  stage = '安装自有透明观察器';
  probeAttempted = true;
  await awaitMain(() => cdp.evaluate(`(() => {
    if (window.__kairo_employee_search_probe) throw new Error('已有人员搜索观察器，拒绝覆盖');
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const originalSend = ipc.send;
    let active = true;
    const counts = Object.create(null);
    const observedSend = function(...args) {
      if (active && args[0] === 'data') {
        const method = args[1]?.args?.[0];
        // 不保留请求参数；未知方法也只计数，不读取可能含正文的载荷。
        const key = typeof method === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(method) ? method : '未知方法';
        counts[key] = (counts[key] || 0) + 1;
      }
      return Reflect.apply(originalSend, this, args);
    };
    const probe = {
      runId: ${JSON.stringify(runId)},
      cleanup() {
        active = false;
        const restored = ipc.send === observedSend;
        if (restored) ipc.send = originalSend;
        // 后续调用方可能包装了send；只停用自身，不覆盖其修改。
        if (window.__kairo_employee_search_probe === probe) delete window.__kairo_employee_search_probe;
        return { owned: true, restored, counts: { ...counts } };
      },
    };
    ipc.send = observedSend;
    window.__kairo_employee_search_probe = probe;
  })()`));
}

async function cleanupProbe(): Promise<Record<string, number>> {
  if (!probeAttempted) return {};
  stage = '恢复自有透明观察器';
  const observed = await cdp.evaluate<{
    owned: boolean; restored?: boolean; counts?: Record<string, number>;
  }>(`(() => {
    const probe = window.__kairo_employee_search_probe;
    if (probe?.runId !== ${JSON.stringify(runId)}) return { owned: false };
    return probe.cleanup();
  })()`);
  probeAttempted = false;
  report['搜索期间原生方法计数'] = observed.counts ?? {};
  check(observed.owned, '自有搜索观察器缺失或被其他调用方替换');
  check(observed.restored, 'ipc.send被其他调用方修改；已停用自身且未覆盖后续修改');
  const counts = observed.counts ?? {};
  check(Object.keys(counts).every(method => ['unionSearch', 'getMemberDetail', 'getAllDeptPaths'].includes(method)),
    '搜索出现白名单外data方法，不能证明未建会话、草稿、发送或标已读');
  return counts;
}

try {
  check(args.length === 4 && uid && login && keyword && candidateUid,
    '参数：登录UID 登录账号 搜索词 候选UID；仅核对指定账号与搜索范围');
  check(/^[1-9]\d*$/.test(uid) && Number.isSafeInteger(Number(uid)) &&
    /^[1-9]\d*$/.test(candidateUid) && Number.isSafeInteger(Number(candidateUid)), '登录UID或候选UID无效');
  check(login.trim().length > 0 && keyword.trim().length > 0, '登录账号或搜索词为空白');
  report['指定范围'] = {
    登录UID: uid,
    候选UID: candidateUid,
    搜索词: keyword.trim(),
  };
  stage = '连接独立CDP';
  await awaitMain(() => cdp.connect());
  connected = true;
  before = await snapshot();
  report['查询前基线'] = before;

  // 必须无参读取原生实际登录身份，不能用缓存用户或候选档案代替。
  const identity = await query<{ id?: unknown; login_name?: unknown }>('getMemberDetail');
  check(String(identity.id) === uid && identity.login_name === login, '原生实际登录UID或login_name与指定账号不符');
  report['原生登录身份严格核对'] = true;
  stage = '连接只读Driver';
  await awaitMain(() => driver.connect());
  const beforeSearch = await snapshot();
  report['搜索前资源'] = beforeSearch;
  await installProbe();
  stage = '执行Driver.searchEmployees';
  const result: KK9EmployeeSearchResult = await awaitMain(() => driver.searchEmployees(keyword));
  // 搜索失败由外层先记录首错，再在finally恢复探针；清理错误不能覆盖原生失败。
  const counts = await cleanupProbe();
  check((counts['unionSearch'] ?? 0) > 0 && (counts['getMemberDetail'] ?? 0) > 0 &&
    (counts['getAllDeptPaths'] ?? 0) > 0, '搜索未观察到完整原生搜索、档案与部门读取');
  const afterSearch = await snapshot();
  report['搜索后资源'] = afterSearch;
  stage = '核对搜索前后会话、窗口与资源';
  assert.deepEqual(afterSearch, beforeSearch, '搜索改变会话集合、窗口、读索引或资源');
  assert.deepEqual(afterSearch.sessions, before.sessions, '连接或搜索改变原生会话集合或读索引');
  check(afterSearch.windowId === before.windowId, '连接或搜索改变当前窗口');
  check(result.hasMore === false, '搜索未声明全部分页完成');
  check(Array.isArray(result.employees), '搜索结果缺少人员数组');
  const resultIds = result.employees.map(employee => employee.id);
  check(resultIds.every(id => typeof id === 'string' && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))),
    '搜索结果存在无效UID');
  check(new Set(resultIds).size === resultIds.length, '搜索结果UID重复');
  check(resultIds.includes(candidateUid), '搜索结果不包含指定候选UID');

  const nativeIds = new Set<string>();
  let nativePages = 0;
  for (let pageNo = 1; ; pageNo++) {
    const page = await query<{ users?: Array<{ id?: unknown }> }>('unionSearch',
      [{ type: 'user', kwd: keyword.trim(), pageNo, pageSize: 200 }]);
    nativePages++;
    check(Array.isArray(page.users), '独立unionSearch分页缺少users数组');
    for (const user of page.users) {
      check(user && /^[1-9]\d*$/.test(String(user.id)) && Number.isSafeInteger(Number(user.id)),
        '独立unionSearch候选缺少有效UID');
      nativeIds.add(String(user.id));
    }
    // 必须按原始页长结束，不能按去重后的数量判断。
    if (page.users.length < 200) break;
  }
  check(nativeIds.size === resultIds.length && resultIds.every(id => nativeIds.has(id)),
    '搜索结果UID集合与独立原生全分页不一致');
  let employeesWithDepartments = 0;
  for (const employee of result.employees) {
    const profile = await query<{ id?: unknown; name?: unknown; login_name?: unknown }>(
      'getMemberDetail', [Number(employee.id)]);
    check(String(profile.id) === employee.id, '独立档案缺席或UID与候选不符');
    const nativeName = typeof profile.name === 'string' && profile.name.trim() ? profile.name : null;
    const nativeLogin = typeof profile.login_name === 'string' && profile.login_name.trim() ? profile.login_name : null;
    check(employee.name === nativeName, '搜索姓名与原生真实name不一致');
    check(employee.loginName === nativeLogin, '搜索工号与原生真实login_name不一致');
    const rawPaths = await query<Array<{ deptPaths?: Array<{ name?: unknown }> }>>(
      'getAllDeptPaths', [Number(employee.id)]);
    check(Array.isArray(rawPaths), '独立部门查询未返回数组');
    const expectedPaths = new Set<string>();
    // 不复用任何新增解析助手；逐条核对原生祖先到叶子顺序的可见部门链。
    for (const entry of rawPaths) {
      check(entry && Array.isArray(entry.deptPaths), '独立部门查询缺少部门链数组');
      const names: string[] = [];
      for (const node of entry.deptPaths) {
        check(node && typeof node.name === 'string' && node.name.trim().length > 0,
          '独立部门链存在畸形或空白名称节点，不能截短链');
        names.push(node.name);
      }
      if (names.length) expectedPaths.add(names.join(' / '));
    }
    if (!expectedPaths.size) {
      check(employee.departmentPaths === null, '原生未提供可见部门时必须返回null');
    } else {
      check(Array.isArray(employee.departmentPaths), '原生存在可见部门链但结果缺失');
      const actualPaths = employee.departmentPaths;
      check(new Set(actualPaths).size === actualPaths.length && actualPaths.length === expectedPaths.size &&
        actualPaths.every(path => expectedPaths.has(path)), '搜索部门链与独立原生可见链不一致');
      employeesWithDepartments++;
    }
  }
  report['核对摘要'] = {
    独立原生分页数: nativePages,
    员工数: resultIds.length,
    含可见部门员工数: employeesWithDepartments,
    包含指定候选: true,
    UID无重复: true,
    全分页集合与档案及部门链一致: true,
    hasMore: result.hasMore,
  };
  stage = '核对无实时事件派发';
  assert.deepEqual(realtimeEvents, { message: 0, at: 0, recalled: 0 }, '搜索不得派发message、at或recalled');
} catch (error) {
  if (error !== independentError) fail(error);
} finally {
  exiting = true;
  // 先断Driver，使竞速退出的在途查询拒绝，不能在恢复探针后继续下一页或档案查询。
  try { await driver.disconnect(); } catch (error) { fail(error, 'Driver退出'); }
  if (connected && probeAttempted) {
    try { await cleanupProbe(); } catch (error) { fail(error, '最终清理自有观察器'); }
  }
  if (connected && cdp.getStatus() === 'connected') {
    try {
      const generationId = driver.getStartupGenerationId();
      // Driver自身失联时，健康独立连接只释放仍归本代所有的远端Hook及binding。
      await cdp.evaluate(`(() => {
        const cleanup = window.__kairo_bridge_cleanup;
        if (typeof cleanup !== 'function' || cleanup.generationId !== ${JSON.stringify(generationId)}) return;
        const binding = window.__kairo_native_bridge;
        try { cleanup(); }
        finally {
          if (window.__kairo_native_bridge === binding) delete window.__kairo_native_bridge;
        }
      })()`);
    } catch (error) { fail(error, '独立CDP清理本代Hook与binding'); }
  }
  if (connected) {
    try {
      const after = await snapshot();
      report['退出后基线'] = after;
      stage = '核对退出后会话、窗口、Hook与监听回基线';
      if (before) assert.deepEqual(after, before, '退出后会话、窗口、Hook、监听或在途发送未恢复');
      assert.deepEqual(realtimeEvents, { message: 0, at: 0, recalled: 0 }, '验收期间派发了实时事件');
    } catch (error) { fail(error); }
  }
  try { await cdp.disconnect(); } catch (error) { fail(error, '独立CDP退出'); }
  try {
    stage = '核对Driver与独立CDP均已断开';
    assert.equal(driver.getStatus(), 'disconnected');
    assert.equal(cdp.getStatus(), 'disconnected');
  } catch (error) { fail(error); }
  report['实时事件计数'] = realtimeEvents;
  report['结束时间'] = new Date().toISOString();
  report['通过'] = failures.length === 0;
  try {
    await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
    await writeFile(new URL('../tmp/employee-search-live-evidence.json', import.meta.url), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    fail(error, '保存验收证据');
    console.error('人员搜索验收证据保存失败');
  }
}
