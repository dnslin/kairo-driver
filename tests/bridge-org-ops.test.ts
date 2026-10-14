import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { BridgeOrgOps } from '../src/bridge/org-ops.js';
import { FakeIpcRenderer, runRendererScript } from './helpers/renderer-runtime.js';

function nativeOrg(responder: ConstructorParameters<typeof FakeIpcRenderer>[0]) {
  const ipc = new FakeIpcRenderer(responder);
  const cdp = {
    evaluate: (script: string) => runRendererScript(script, {
      window: { ipcRenderer: ipc }, setTimeout, clearTimeout,
    }),
  } as unknown as CdpClient;
  return new BridgeOrgOps(cdp);
}

describe('原生组织与员工查询', () => {
  it('无窗口从可见根遍历部门，满页继续且成员按 UID 去重', async () => {
    const first = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, name: `员工${i + 1}` }));
    const ops = nativeOrg(({ args: [method, value] }) => {
      if (method === 'getDepartmentVisible') return { code: 0, data: [{ id: 15 }] };
      if (method !== 'getChildDeptsAndMembers') throw new Error('不应查询另一套实现');
      const { deptID, pageNo } = value as { deptID: number; pageNo: number };
      if (deptID === 15 && pageNo === 1) return { code: 0, data: { depts: [{ id: 29 }], members: first } };
      if (deptID === 15 && pageNo === 2) return { code: 0, data: { depts: [], members: [{ id: 201, name: '第二页' }] } };
      if (deptID === 29) return { code: 0, data: { depts: [{ id: 15 }], members: [{ id: 201, name: '重复' }, { id: 202, name: '子部门' }] } };
      throw new Error('错误部门或页');
    });
    const employees = await ops.getOrgEmployees();
    expect(employees.map(e => e.id)).toEqual(Array.from({ length: 202 }, (_, i) => i + 1));
    expect(employees.find(e => e.id === 201)?.name).toBe('第二页');
    expect(employees.find(e => e.id === 202)?.name).toBe('子部门');
  });

  it('分页失败不能把首页员工当全量成功，保留部门、页和原生诊断', async () => {
    const ops = nativeOrg(({ args: [method, value] }) => {
      if (method === 'getDepartmentVisible') return { code: 0, data: [{ id: 15 }] };
      const { pageNo } = value as { pageNo: number };
      return pageNo === 1
        ? { code: 0, data: { depts: [], members: Array.from({ length: 200 }, (_, i) => ({ id: i + 1 })) } }
        : { code: 627, error: '部门请求失败' };
    });
    await expect(ops.getOrgEmployees()).rejects.toThrow(/getChildDeptsAndMembers.*15.*2.*627.*部门请求失败/);
  });

  it('遍历期限耗尽抛错而非返回已收集部分', async () => {
    const ops = nativeOrg(() => ({ code: 0, data: [{ id: 15 }] }));
    await expect(ops.getOrgEmployees(0)).rejects.toThrow(/超时/);
  });

  it('指定档案正常缺席返回 null，原生失败不降级查询其他接口', async () => {
    const ops = nativeOrg(({ args: [method, id] }) => {
      if (method !== 'getMemberDetail') throw new Error('不应降级');
      return id === 3585 ? { code: 0, data: { id: 3585, login_name: 'int2024', name: '对端', deptPaths: [{ id: 29, name: 'IT组' }] } }
        : id === 9999 ? { code: 0, data: null } : { code: 627, error: '档案读取失败' };
    });
    expect(await ops.getUserProfile('3585')).toMatchObject({ id: 3585, loginName: 'int2024', deptPaths: [{ id: 29, name: 'IT组' }] });
    await expect(ops.getUserProfile(9999)).resolves.toBeNull();
    await expect(ops.getUserProfile(8888)).rejects.toThrow(/getMemberDetail.*8888.*627.*档案读取失败/);
  });

  it('零填充 UID 不触发原生当前账号默认身份', async () => {
    const ops = nativeOrg(({ args: [, value] }) => {
      // 原生 getMemberDetail 将假值 UID 替换为当前登录 UID。
      const uid = value || 5761;
      return { code: 0, data: uid === 5761 ? { id: 5761, name: '当前账号' } : null };
    });
    await expect(ops.getUserProfile('000')).resolves.toBeNull();
  });
});

describe('只读人员搜索', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('按原始页长度继续查询，跨页同UID合并而同名不同UID全部保留', async () => {
    const ops = nativeOrg(({ args: [method, value] }) => {
      if (method === 'unionSearch') {
        const { kwd, pageNo } = value as { kwd: string; pageNo: number };
        expect(kwd).toBe('张三');
        return { code: 0, data: { users: pageNo === 1
          ? Array.from({ length: 200 }, () => ({ id: 1, name: '张三', login_name: '过时工号' }))
          : [{ id: '1', name: '张三' }, { id: 2, name: '张三' }] } };
      }
      if (method === 'getMemberDetail') return { code: 0, data: { id: value, name: '张三', login_name: value === 1 ? 'E102' : 'E208' } };
      if (method === 'getAllDeptPaths') return { code: 0, data: value === 1 ? [
        { deptPaths: [{ id: 10, name: '研发中心' }, { id: 11, name: '后端组' }] },
        { deptPaths: [{ id: 20, name: '项目中心' }, { id: 21, name: '平台组' }] },
      ] : [{ deptPaths: [{ id: 30, name: '销售中心' }, { id: 31, name: '华东区' }] }] };
      throw new Error(`搜索不得执行写操作或其他查询: ${String(method)}`);
    });
    expect(await ops.searchEmployees('  张三  ')).toEqual({
      employees: [
        { id: '1', name: '张三', loginName: 'E102', departmentPaths: ['研发中心 / 后端组', '项目中心 / 平台组'] },
        { id: '2', name: '张三', loginName: 'E208', departmentPaths: ['销售中心 / 华东区'] },
      ], hasMore: false,
    });
  });

  it('整页后的空页才能结束，部门缺失不拿职位补充', async () => {
    const ops = nativeOrg(({ args: [method, value] }) => {
      if (method === 'unionSearch') {
        const { pageNo } = value as { pageNo: number };
        return { code: 0, data: { users: pageNo === 1 ? Array.from({ length: 200 }, () => ({ id: 1 })) : [] } };
      }
      if (method === 'getMemberDetail') return { code: 0, data: { id: 1, name: '张三', login_name: '000102', pos: '销售中心主管', deptPaths: [{ id: 99, name: '默认部门不是所有部门来源' }] } };
      if (method === 'getAllDeptPaths') return { code: 0, data: [{ deptPaths: [] }] };
      throw new Error('搜索不允许其他原生操作');
    });
    expect(await ops.searchEmployees('张三')).toEqual({ employees: [{
      id: '1', name: '张三', loginName: '000102', departmentPaths: null,
    }], hasMore: false });
  });

  it('姓名和真实工号缺失返回null，不使用UID、别名工号或搜索页旧值', async () => {
    const ops = nativeOrg(({ args: [method] }) => {
      if (method === 'unionSearch') return { code: 0, data: { users: [{ id: 1, name: '搜索显示名', login_name: '旧工号' }] } };
      if (method === 'getMemberDetail') return { code: 0, data: { id: 1, name: '  ', login_name: '', loginName: '别名账号', job_number: '职位编号' } };
      if (method === 'getAllDeptPaths') return { code: 0, data: [] };
      throw new Error('不得降级');
    });
    expect(await ops.searchEmployees('搜索')).toEqual({ employees: [{ id: '1', name: null, loginName: null, departmentPaths: null }], hasMore: false });
  });

  it('正常空搜索返回完整空结果且不查档案或创建会话', async () => {
    const ops = nativeOrg(({ args: [method] }) => {
      if (method !== 'unionSearch') throw new Error('空搜索不得查档案或创建会话');
      return { code: 0, data: { users: [] } };
    });
    expect(await ops.searchEmployees('无人')).toEqual({ employees: [], hasMore: false });
  });

  it('后页失败抛错，不把首页去重后的一位当成完整成功', async () => {
    const ops = nativeOrg(({ args: [method, value] }) => {
      if (method !== 'unionSearch') throw new Error('分页未完成不应开始档案查询');
      const { pageNo } = value as { pageNo: number };
      return pageNo === 1
        ? { code: 0, data: { users: Array.from({ length: 200 }, () => ({ id: 1 })) } }
        : { code: 627, error: '后页人员不可读' };
    });
    await expect(ops.searchEmployees('张三')).rejects.toThrow(/unionSearch.*2.*627.*后页人员不可读/);
  });

  it.each([
    ['人员数组缺失', 'unionSearch', { unexpected: [] }, /unionSearch.*人员数组/],
    ['人员UID为零', 'unionSearch', { users: [{ id: 0 }] }, /unionSearch.*UID/],
    ['档案缺席', 'getMemberDetail', null, /getMemberDetail.*1.*档案/],
    ['档案错人', 'getMemberDetail', { id: 2, name: '其他人' }, /getMemberDetail.*1.*UID/],
    ['部门响应不是数组', 'getAllDeptPaths', {}, /getAllDeptPaths.*1.*数组/],
    ['部门链缺失', 'getAllDeptPaths', [{}], /getAllDeptPaths.*1.*路径/],
    ['部门名称缺失', 'getAllDeptPaths', [{ deptPaths: [{ id: 10, name: '中心' }, { id: 11 }] }], /getAllDeptPaths.*1.*名称/],
  ])('%s不得静默丢候选或伪造完整性', async (_title, failedMethod, data, error) => {
    const ops = nativeOrg(({ args: [method] }) => {
      if (method === failedMethod) return { code: 0, data };
      if (method === 'unionSearch') return { code: 0, data: { users: [{ id: 1 }] } };
      if (method === 'getMemberDetail') return { code: 0, data: { id: 1, name: '张三', login_name: 'E102' } };
      throw new Error('不应进入其他方法');
    });
    await expect(ops.searchEmployees('张三')).rejects.toThrow(error);
  });

  it('整轮档案期限耗尽也不能返回部分候选', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const ops = nativeOrg(({ args: [method] }) => {
      if (method === 'unionSearch') return { code: 0, data: { users: [{ id: 1 }] } };
      if (method === 'getMemberDetail') { vi.setSystemTime(1030); return { code: 0, data: { id: 1 } }; }
      throw new Error('超时不应继续查询');
    });
    await expect(ops.searchEmployees('张三', 30)).rejects.toThrow(/getMemberDetail.*1.*超时/);
  });

  it('空关键词或无效期限在任何原生查询前拒绝', async () => {
    const ops = nativeOrg(() => { throw new Error('不得访问原生'); });
    await expect(ops.searchEmployees('  ')).rejects.toThrow(/关键词/);
    for (const timeout of [0, -1, NaN, Infinity]) await expect(ops.searchEmployees('张三', timeout)).rejects.toThrow(/期限|超时/);
  });
});
