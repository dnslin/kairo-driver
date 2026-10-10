import { describe, expect, it } from 'vitest';
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
});
