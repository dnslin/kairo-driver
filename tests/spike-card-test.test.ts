import { describe, expect, it, vi } from 'vitest';
import { runSpikeCardTest } from '../examples/spike-card-test.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';

const env = {
  KK9_MEDIA_TARGET_ID: '93001',
  KK9_MEDIA_TARGET_NAME: '员工甲',
  KK9_MEDIA_CONFIRM: '91001:93001:员工甲',
};
const logger = { log: vi.fn(), error: vi.fn() };
const input = {
  kind: 'url' as const,
  data: { title: '测试链接', summary: '测试通知', linkUrl: 'https://example.com' },
};
function harness() {
  const native = createNativeSendRuntime();
  Object.assign(native.cdp, { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) });
  return native;
}

describe('卡片诊断原生门禁', () => {
  it('同名会话不能代替指定原生ID', async () => {
    const native = harness();
    native.sessions[0]!.id = 93003;
    const result = await runSpikeCardTest({ cdp: native.cdp, env, input, logger });
    expect(result.exitCode).toBe(1);
    expect(native.drafts).toEqual([]);
  });

  it('确认值与实际登录UID不符时不发送', async () => {
    const native = harness();
    const result = await runSpikeCardTest({
      cdp: native.cdp,
      env: { ...env, KK9_MEDIA_CONFIRM: '999:93001:员工甲' },
      input,
      logger,
    });
    expect(result.exitCode).toBe(1);
    expect(native.drafts).toEqual([]);
  });
});
