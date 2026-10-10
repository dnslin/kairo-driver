import type { KK9Employee } from '../types/index.js';

/**
 * 清洗并获取非空字符串，若为空或全空白符则返回 undefined
 */
function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

/**
 * 尝试从多个候选属性键中读取首个非空字符串
 */
function pickFirstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const cleaned = cleanOptionalString(obj[key]);
    if (cleaned !== undefined) {
      return cleaned;
    }
  }
  return undefined;
}

/**
 * 解析单个原始对象为标准 KK9Employee 实体
 * 包含多格式兼容、空白清洗与防御性降级
 */
export function parseEmployee(raw: unknown): KK9Employee | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;

  // 防护：排除聊天会话对象 (防止误将会话列表当做通讯录)
  if (
    ('sesUUID' in record || 'maxMessageIndex' in record || 'userReadIndex' in record) &&
    !('login_name' in record || 'f_spell' in record || 'deptPaths' in record)
  ) {
    return null;
  }

  // 1. 提取唯一员工 ID
  let id: number | string | null = null;
  const rawId =
    record.id ?? record.userId ?? record.user_id ?? record.uid ?? record.empId ?? record.emp_id;

  if (typeof rawId === 'number' && Number.isFinite(rawId)) {
    id = rawId;
  } else if (typeof rawId === 'string') {
    const trimmed = rawId.trim();
    if (trimmed.length > 0) {
      id = trimmed;
    }
  }

  if (id === null) {
    return null;
  }

  // 2. 提取工号 / 登录名 (多别名支持与回退)
  const loginNameCandidates = [
    'loginName',
    'login_name',
    'job_number',
    'loginCode',
    'login_code',
    'code',
    'account',
    'staffNo',
    'staff_no',
    'workNo',
    'work_no',
  ];
  const rawLoginName = pickFirstString(record, loginNameCandidates);
  const loginName = rawLoginName ?? String(id);

  // 3. 提取真实姓名 (多别名支持与回退)
  const nameCandidates = [
    'name',
    'realName',
    'real_name',
    'userName',
    'user_name',
    'showName',
    'show_name',
    'nickName',
    'nick_name',
  ];
  const rawName = pickFirstString(record, nameCandidates);
  let name: string;
  if (rawName) {
    name = rawName;
  } else if (rawLoginName) {
    name = rawLoginName;
  } else {
    name = `员工_${String(id)}`;
  }

  // 4. 提取可选属性 (岗位、物理工位、个性签名、电话、邮箱、头像等)
  const position = pickFirstString(record, [
    'pos',
    'position',
    'position_desc',
    'title',
    'job',
    'post',
    'department',
    'dept',
  ]);
  const region = pickFirstString(record, ['region', 'location', 'office', 'workplace', 'area']);
  const signature = pickFirstString(record, ['sig', 'signature', 'bio', 'memo']);
  const phone = pickFirstString(record, ['phone', 'mobile', 'tel']);
  const email = pickFirstString(record, ['email', 'mail']);
  const avatarUrl = pickFirstString(record, [
    'avatarUrl',
    'avatar_url',
    'avatar',
    'icon',
    'headUrl',
    'head_url',
    'photo',
  ]);

  const employee: KK9Employee = {
    id,
    loginName,
    name,
    updatedAt: Date.now(),
    raw: record,
  };

  if (position !== undefined) employee.position = position;
  if (region !== undefined) employee.region = region;
  if (signature !== undefined) employee.signature = signature;
  if (phone !== undefined) employee.phone = phone;
  if (email !== undefined) employee.email = email;
  if (avatarUrl !== undefined) employee.avatarUrl = avatarUrl;

  return employee;
}

/**
 * 批量解析原始数组为标准 KK9Employee 列表，自动过滤无效项
 */
export function parseEmployeeList(list: unknown): KK9Employee[] {
  if (!Array.isArray(list)) {
    return [];
  }

  const result: KK9Employee[] = [];
  for (const item of list) {
    const employee = parseEmployee(item);
    if (employee !== null) {
      result.push(employee);
    }
  }

  return result;
}

