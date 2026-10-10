import type { CdpClient } from '../cdp/client.js';
import type { KK9Employee } from '../types/index.js';
import { parseEmployee } from '../dom/org-ops.js';
import { callIpcToData } from './rpc.js';
import { DriverError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('bridge-org-ops');
interface RawDepartment { id: number; name: string }
interface RawChildDeptsAndMembersResult {
  depts: RawDepartment[];
  members: Array<Record<string, unknown>>;
}

export class BridgeOrgOps {
  constructor(private readonly cdp: CdpClient) {}

  /** 从原生可见根部门分页遍历；任何中断都抛错，不返回部分全量。 */
  public async getOrgEmployees(timeoutMs = 30000): Promise<KK9Employee[]> {
    const startTime = Date.now();
    const deadline = startTime + timeoutMs;
    const allEmployees = new Map<string, KK9Employee>();
    const visitedDepts = new Set<number>();
    const query = async <T>(method: string, args: unknown[], context: string): Promise<T | undefined> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DriverError(`${method} ${context} 组织遍历超时 (${timeoutMs}ms)`, 'IPC_QUERY_FAILED');
      try {
        const res = await callIpcToData<T>(this.cdp, method, args, Math.min(4000, remaining));
        if (res.code !== 0) throw new Error(`失败 (${res.code}): ${res.error || res.message || ''}`);
        if (Date.now() >= deadline) throw new Error(`组织遍历超时 (${timeoutMs}ms)`);
        return res.data;
      } catch (err) {
        throw new DriverError(`${method} ${context}: ${String(err)}`, 'IPC_QUERY_FAILED', err instanceof Error ? err : undefined);
      }
    };
    const roots = await query<RawDepartment[]>('getDepartmentVisible', [], '根部门');
    if (!Array.isArray(roots)) throw new DriverError('getDepartmentVisible 未返回部门数组', 'IPC_INVALID_RESPONSE');
    const queue = roots.map(dept => dept.id);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const deptId = queue[cursor]!;
      if (visitedDepts.has(deptId)) continue;
      if (visitedDepts.size >= 1500) throw new DriverError(`getChildDeptsAndMembers 部门 ${deptId} 遍历超过1500部门，中断`, 'IPC_QUERY_FAILED');
      visitedDepts.add(deptId);
      for (let pageNo = 1; ; pageNo++) {
        const context = `部门 ${deptId} 页 ${pageNo}`;
        const data = await query<RawChildDeptsAndMembersResult>('getChildDeptsAndMembers', [{ deptID: deptId, pageSize: 200, pageNo, needDeptPath: true }], context);
        if (!Array.isArray(data?.members) || !Array.isArray(data.depts)) throw new DriverError(`getChildDeptsAndMembers ${context} 未返回成员/部门数组`, 'IPC_INVALID_RESPONSE');
        for (const raw of data.members) {
          const employee = parseEmployee(raw);
          if (!employee) throw new DriverError(`getChildDeptsAndMembers ${context} 成员缺少 UID`, 'IPC_INVALID_RESPONSE');
          if (!allEmployees.has(String(employee.id))) allEmployees.set(String(employee.id), employee);
        }
        if (pageNo === 1) for (const dept of data.depts) if (!visitedDepts.has(dept.id)) queue.push(dept.id);
        if (data.members.length < 200) break;
      }
    }
    log.info({ count: allEmployees.size, deptsScanned: visitedDepts.size, durationMs: Date.now() - startTime }, '原生可见组织遍历完成');
    return [...allEmployees.values()];
  }

  /** 按员工 UID 查询原生档案；正常缺席与查询失败分开。 */
  public async getUserProfile(userId: number | string): Promise<KK9Employee | null> {
    const uid = String(userId ?? '').trim();
    if (!uid) return null;
    const target = /^[0-9]+$/.test(uid) ? Number(uid) : uid;
    try {
      const res = await callIpcToData<(Record<string, unknown> & { deptPaths?: KK9Employee['deptPaths'] }) | null>(this.cdp, 'getMemberDetail', [target], 3000);
      if (res.code !== 0) throw new Error(`失败 (${res.code}): ${res.error || res.message || ''}`);
      if (res.data == null) return null;
      const employee = parseEmployee(res.data);
      if (!employee) throw new Error('档案缺少 UID');
      if (Array.isArray(res.data.deptPaths)) employee.deptPaths = res.data.deptPaths;
      return employee;
    } catch (err) {
      throw new DriverError(`getMemberDetail 员工 ${uid}: ${String(err)}`, 'IPC_QUERY_FAILED', err instanceof Error ? err : undefined);
    }
  }
}
