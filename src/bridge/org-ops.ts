import type { CdpClient } from '../cdp/client.js';
import type { KK9Employee, KK9EmployeeSearchItem, KK9EmployeeSearchResult } from '../types/index.js';
import { parseEmployee } from '../utils/employee.js';
import { callIpcToData } from './rpc.js';
import { DriverError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('bridge-org-ops');
interface RawDepartment { id: number; name: string }
interface RawChildDeptsAndMembersResult {
  depts: RawDepartment[];
  members: Array<Record<string, unknown>>;
}


function searchUid(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return null;
  const uid = Number(value);
  return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
}

function profileText(value: unknown, context: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new DriverError(`${context} 不是字符串`, 'IPC_INVALID_RESPONSE');
  return value.trim() ? value : null;
}
export class BridgeOrgOps {
  constructor(private readonly cdp: CdpClient) {}

  /** 查完当前账号可搜索结果再返回；失败不返回部分候选，不执行会话或发送操作。 */
  public async searchEmployees(keyword: string, timeoutMs = 30000): Promise<KK9EmployeeSearchResult> {
    const kwd = keyword.trim();
    if (!kwd) throw new DriverError('人员搜索关键词不能为空', 'IPC_QUERY_FAILED');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new DriverError('人员搜索期限必须为有限正数，零期限已超时', 'IPC_QUERY_FAILED');
    const deadline = Date.now() + timeoutMs;
    const query = async (method: string, args: unknown[], context: string): Promise<unknown> => {
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`人员搜索超时 (${timeoutMs}ms)`);
        const result = await callIpcToData(this.cdp, method, args, Math.min(4000, remaining), remaining);
        if (result.code !== 0) throw new Error(`失败 (${result.code}): ${result.error || result.message || ''}`);
        if (Date.now() >= deadline) throw new Error(`人员搜索超时 (${timeoutMs}ms)`);
        return result.data;
      } catch (error) {
        throw new DriverError(`${method} ${context}: ${String(error)}`, 'IPC_QUERY_FAILED', error instanceof Error ? error : undefined);
      }
    };

    const uids = new Set<number>();
    for (let pageNo = 1; ; pageNo++) {
      const data = await query('unionSearch', [{ type: 'user', kwd, pageNo, pageSize: 200 }], `页 ${pageNo}`);
      if (!data || typeof data !== 'object' || !('users' in data) || !Array.isArray(data.users)) throw new DriverError(`unionSearch 页 ${pageNo} 未返回人员数组`, 'IPC_INVALID_RESPONSE');
      const users: unknown[] = data.users;
      for (const user of users) {
        const uid = user && typeof user === 'object' && 'id' in user ? searchUid(user.id) : null;
        if (uid === null) throw new DriverError(`unionSearch 页 ${pageNo} 人员缺少有效 UID`, 'IPC_INVALID_RESPONSE');
        uids.add(uid);
      }
      // 原生使用数据库 limit/offset；结束依据是原始页长度，不是去重后的候选数。
      if (users.length < 200) break;
    }

    const employees: KK9EmployeeSearchItem[] = [];
    for (const uid of uids) {
      const profile = await query('getMemberDetail', [uid], `UID ${uid}`);
      if (!profile || typeof profile !== 'object' || !('id' in profile)) throw new DriverError(`getMemberDetail UID ${uid} 档案缺席或无效`, 'IPC_INVALID_RESPONSE');
      if (searchUid(profile.id) !== uid) throw new DriverError(`getMemberDetail UID ${uid} 档案 UID 不符`, 'IPC_INVALID_RESPONSE');
      const name = profileText('name' in profile ? profile.name : null, `getMemberDetail UID ${uid} 姓名`);
      const loginName = profileText('login_name' in profile ? profile.login_name : null, `getMemberDetail UID ${uid} login_name`);
      const departments = await query('getAllDeptPaths', [uid], `UID ${uid}`);
      if (!Array.isArray(departments)) throw new DriverError(`getAllDeptPaths UID ${uid} 未返回部门数组`, 'IPC_INVALID_RESPONSE');
      const departmentRows: unknown[] = departments;
      const paths = new Set<string>();
      for (const department of departmentRows) {
        if (!department || typeof department !== 'object' || !('deptPaths' in department) || !Array.isArray(department.deptPaths)) throw new DriverError(`getAllDeptPaths UID ${uid} 部门路径无效`, 'IPC_INVALID_RESPONSE');
        const nodes: unknown[] = department.deptPaths;
        const names: string[] = [];
        for (const node of nodes) {
          if (!node || typeof node !== 'object' || !('name' in node) || typeof node.name !== 'string' || !node.name.trim()) throw new DriverError(`getAllDeptPaths UID ${uid} 部门路径名称缺失或无效`, 'IPC_INVALID_RESPONSE');
          names.push(node.name);
        }
        if (names.length) paths.add(names.join(' / '));
      }
      employees.push({ id: String(uid), name, loginName, departmentPaths: paths.size ? [...paths] : null });
    }
    return { employees, hasMore: false };
  }

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
    if (target === 0) return null;
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
