import type { KK9EventBridge } from '../../src/bridge/event-bridge.js';
import type { BridgeMessageOps } from '../../src/bridge/message-ops.js';
import type { BridgeOrgOps } from '../../src/bridge/org-ops.js';
import type { BridgeSessionOps } from '../../src/bridge/session-ops.js';
import type { CdpClient } from '../../src/cdp/client.js';
import type { KK9Driver } from '../../src/driver.js';
import type { KK9RecalledEvent } from '../../src/types/index.js';

interface DriverTestInternalSlots {
  cdp: CdpClient;
  eventBridge: KK9EventBridge;
  bridgeSessionOps: BridgeSessionOps;
  bridgeMessageOps: BridgeMessageOps;
  bridgeOrgOps: BridgeOrgOps;
  handleRecalledEvent(event: KK9RecalledEvent): void;
}

export type DriverTestInternals<TOverrides extends object = Record<never, never>> = Omit<
  DriverTestInternalSlots,
  keyof TOverrides
> &
  TOverrides;

/** 测试专用：显式绕过 KK9Driver 的编译期私有边界。 */
export function getDriverTestInternals<TOverrides extends object = Record<never, never>>(
  driver: KK9Driver
): DriverTestInternals<TOverrides> {
  return driver as unknown as DriverTestInternals<TOverrides>;
}
