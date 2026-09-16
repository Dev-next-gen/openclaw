import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi, type Mock } from "vitest";
import { getAcpRuntimeBackend } from "../runtime-api.js";
import type { OpenClawPluginServiceContext } from "../runtime-api.js";
import type { AcpxProcessLease } from "./process-lease.js";
import type { cleanupOpenClawOwnedAcpxProcessTree } from "./process-reaper.js";
import type { AcpxRuntime } from "./runtime.js";
import type { createAcpxRuntimeService } from "./service.js";
import { ACPX_GATEWAY_INSTANCE_KEY, type AcpxGatewayInstanceRecord } from "./state.js";

type ServiceParams = Parameters<typeof createAcpxRuntimeService>[0];
type CleanupResult = { inspectedPids: number[]; terminatedPids: number[]; skippedReason?: string };

export function registerInspectionRecoveryTests(harness: {
  createContext: () => OpenClawPluginServiceContext;
  createService: (
    ctx: OpenClawPluginServiceContext,
    params: Omit<ServiceParams, "backendLifecycle"> & {
      backendLifecycle?: ServiceParams["backendLifecycle"];
    },
  ) => ReturnType<typeof createAcpxRuntimeService>;
  createRuntime: () => AcpxRuntime;
  seedLease: (ctx: OpenClawPluginServiceContext) => Promise<AcpxProcessLease>;
  openGatewayStore: (
    ctx: OpenClawPluginServiceContext,
  ) => PluginStateKeyedStore<AcpxGatewayInstanceRecord>;
  openLeaseStore: (ctx: OpenClawPluginServiceContext) => PluginStateKeyedStore<AcpxProcessLease>;
  cleanupTree: Mock<
    (input: Parameters<typeof cleanupOpenClawOwnedAcpxProcessTree>[0]) => Promise<CleanupResult>
  >;
  cleanupPending: Mock<() => Promise<CleanupResult>>;
  cleanupOrphans: Mock<() => Promise<CleanupResult>>;
}): void {
  describe("inspection runtime recovery ownership", () => {
    it("catalog-only acquisition and disposal preserve another active runtime lease", async () => {
      const ctx = harness.createContext();
      await harness.openGatewayStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
        instanceId: "gw-test",
        createdAt: 1,
      });
      const primary = harness.createRuntime();
      const primaryShutdown = vi.spyOn(primary, "shutdown");
      const owner = harness.createService(ctx, {
        probeAtStartup: false,
        runtimeFactory: () => primary,
      });
      await owner.start(ctx);
      const lease = await harness.seedLease(ctx);
      const inspectionRuntime = harness.createRuntime();
      const inspectionShutdown = vi.spyOn(inspectionRuntime, "shutdown");
      const inspection = harness.createService(ctx, {
        startupPurpose: "inspection",
        probeAtStartup: false,
        runtimeFactory: () => inspectionRuntime,
        backendLifecycle: { publish: () => {}, retract: () => {} },
      });
      await inspection.start(ctx);
      await inspection.stop?.(ctx);
      expect(harness.cleanupTree).not.toHaveBeenCalled();
      expect(harness.cleanupPending).not.toHaveBeenCalled();
      expect(harness.cleanupOrphans).not.toHaveBeenCalled();
      expect(await harness.openLeaseStore(ctx).lookup(lease.leaseId)).toEqual(lease);
      expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(primary);
      expect(inspectionShutdown).toHaveBeenCalledOnce();
      expect(primaryShutdown).not.toHaveBeenCalled();
      await owner.stop?.(ctx);
    });

    it("promotes the same inspection runtime to Gateway startup recovery once", async () => {
      const ctx = harness.createContext();
      const lease = await harness.seedLease(ctx);
      const runtime = harness.createRuntime();
      const runtimeFactory = vi.fn(() => runtime);
      const service = harness.createService(ctx, {
        startupPurpose: "inspection",
        probeAtStartup: false,
        runtimeFactory,
      });
      await service.start(ctx);
      expect(harness.cleanupTree).not.toHaveBeenCalled();
      await service.promote(ctx);
      await service.promote(ctx);
      expect(harness.cleanupTree).toHaveBeenCalledOnce();
      expect(runtimeFactory).toHaveBeenCalledOnce();
      expect(await harness.openLeaseStore(ctx).lookup(lease.leaseId)).toBeUndefined();
      await service.stop?.(ctx);
      expect(harness.cleanupTree).toHaveBeenCalledOnce();
    });

    it("joins pending promotion recovery when the service stops", async () => {
      const ctx = harness.createContext();
      const lease = await harness.seedLease(ctx);
      const runtime = harness.createRuntime();
      const shutdown = vi.spyOn(runtime, "shutdown");
      const service = harness.createService(ctx, {
        startupPurpose: "inspection",
        probeAtStartup: false,
        runtimeFactory: () => runtime,
      });
      await service.start(ctx);
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      harness.cleanupTree.mockImplementationOnce(async (input) => {
        entered.resolve();
        await release.promise;
        if (!input.deps?.assertCurrent) {
          throw new Error("Recovery must carry current ownership");
        }
        input.deps.assertCurrent();
        return { inspectedPids: [101], terminatedPids: [101] };
      });
      const promoting = service.promote(ctx);
      const rejected = expect(promoting).rejects.toThrow("stopped during recovery");
      await entered.promise;
      let stopped = false;
      const stopping = Promise.resolve(service.stop?.(ctx)).then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release.resolve();
      await rejected;
      await stopping;
      expect(shutdown).toHaveBeenCalledOnce();
      expect(await harness.openLeaseStore(ctx).lookup(lease.leaseId)).toMatchObject({
        rootPid: 101,
      });
    });
  });
}
