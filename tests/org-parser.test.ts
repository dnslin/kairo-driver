import { describe, expect, it } from 'vitest';
import { parseEmployee, parseEmployeeList } from '../src/utils/employee.js';

describe('员工档案解析清洗', () => {
  describe('parseEmployee: 单个员工对象字段映射与清洗', () => {
    it('应正确解析包含完整字段的标准员工对象 (驼峰与下划线混合兼容)', () => {
      const raw = {
        id: 10086,
        login_name: 'D10086',
        name: '张三',
        pos: '高级前端架构师',
        region: '北京总部 A 座 12F',
        sig: '代码如诗，追求卓越',
        phone: '13800138000',
        email: 'zhangsan@example.com',
        avatarUrl: 'https://cdn.example.com/avatar/10086.png',
      };

      const employee = parseEmployee(raw);
      expect(employee).not.toBeNull();
      expect(employee).toMatchObject({
        id: 10086,
        loginName: 'D10086',
        name: '张三',
        position: '高级前端架构师',
        region: '北京总部 A 座 12F',
        signature: '代码如诗，追求卓越',
        phone: '13800138000',
        email: 'zhangsan@example.com',
        avatarUrl: 'https://cdn.example.com/avatar/10086.png',
        raw,
      });
      expect(typeof employee?.updatedAt).toBe('number');
      expect(employee?.updatedAt).toBeGreaterThan(0);
    });

    it('应兼容多种常见别名属性 (如 realName, position, office, headUrl, code)', () => {
      const raw = {
        userId: 'U9527',
        code: 'E9527',
        realName: '李四',
        position: '测试专家',
        office: '上海研发中心 5F',
        bio: 'Bug 终结者',
        mobile: '13912345678',
        mail: 'lisi@example.com',
        headUrl: 'http://localhost/head.jpg',
      };

      const employee = parseEmployee(raw);
      expect(employee).toEqual(
        expect.objectContaining({
          id: 'U9527',
          loginName: 'E9527',
          name: '李四',
          position: '测试专家',
          region: '上海研发中心 5F',
          signature: 'Bug 终结者',
          phone: '13912345678',
          email: 'lisi@example.com',
          avatarUrl: 'http://localhost/head.jpg',
        })
      );
    });

    it('应对空格多余字符串进行 trim 清洗，并将空白或空字符串字段转为 undefined', () => {
      const raw = {
        id: 2001,
        loginName: '  W2001  ',
        name: '  王五  ',
        pos: '   ',
        region: '',
        sig: '  \n\t  ',
        phone: '  13700000000  ',
      };

      const employee = parseEmployee(raw);
      expect(employee?.id).toBe(2001);
      expect(employee?.loginName).toBe('W2001');
      expect(employee?.name).toBe('王五');
      expect(employee?.position).toBeUndefined();
      expect(employee?.region).toBeUndefined();
      expect(employee?.signature).toBeUndefined();
      expect(employee?.phone).toBe('13700000000');
    });

    it('缺失 loginName 或 name 时应具备合理的防御性回退降级机制', () => {
      const rawNoLoginName = {
        id: 3001,
        name: '赵六',
      };
      const emp1 = parseEmployee(rawNoLoginName);
      expect(emp1?.loginName).toBe('3001');
      expect(emp1?.name).toBe('赵六');

      const rawNoName = {
        id: 'user_3002',
        loginName: 'Z3002',
      };
      const emp2 = parseEmployee(rawNoName);
      expect(emp2?.name).toBe('Z3002');

      const rawMinimal = {
        id: 3003,
      };
      const emp3 = parseEmployee(rawMinimal);
      expect(emp3?.id).toBe(3003);
      expect(emp3?.loginName).toBe('3003');
      expect(emp3?.name).toBe('员工_3003');
    });

    it('对无效输入 (null, undefined, 原始类型, 缺失 id 的对象) 应安全返回 null', () => {
      expect(parseEmployee(null)).toBeNull();
      expect(parseEmployee(undefined)).toBeNull();
      expect(parseEmployee('hello')).toBeNull();
      expect(parseEmployee(12345)).toBeNull();
      expect(parseEmployee({})).toBeNull();
      expect(parseEmployee({ name: '无ID人员' })).toBeNull();
      expect(parseEmployee({ id: '   ' })).toBeNull();
    });
  });

  describe('parseEmployeeList: 批量员工列表清洗与去重过滤', () => {
    it('应正确解析员工数组并过滤无效项', () => {
      const list = [
        { id: 1, name: '员工1', loginName: 'E001' },
        null,
        'invalid item',
        { id: 2, name: '员工2', loginName: 'E002' },
        {},
      ];

      const employees = parseEmployeeList(list);
      expect(employees).toHaveLength(2);
      expect(employees[0]?.id).toBe(1);
      expect(employees[1]?.id).toBe(2);
    });

    it('输入非数组时应防御性返回空数组', () => {
      expect(parseEmployeeList(null)).toEqual([]);
      expect(parseEmployeeList(undefined)).toEqual([]);
      expect(parseEmployeeList({} as unknown[])).toEqual([]);
    });
  });

});
