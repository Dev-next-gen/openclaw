/**
 * Lazy public entrypoint for the gateway server implementation.
 *
 * Keeping `server-start` behind dynamic import lets light-weight callers import
 * server types and helpers without paying the full startup dependency graph.
 */
export { truncateCloseReason } from "./server/close-reason.js";
export type { GatewayServer, GatewayServerOptions } from "./server-public.js";

async function emitStartupTrace(name: string, durationMs: number, totalMs: number): Promise<void> {
  if (!process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) {
    return;
  }
  const { formatConsoleDiagnosticLine } = await import("../logging/json-console-line.js");
  const message = `[gateway] startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`;
  process.stderr.write(`${formatConsoleDiagnosticLine({ level: "info", message })}\n`);
}

async function loadServerStart() {
  const startupStartedAt = performance.now();
  const before = performance.now();
  try {
    return await import("./server-start.js");
  } finally {
    const now = performance.now();
    await emitStartupTrace("gateway.server-start-import", now - before, now - startupStartedAt);
  }
}

/** Starts the gateway server after lazily loading the full server implementation. */
export async function startGatewayServer(
  port = 18789,
  opts: import("./server-public.js").GatewayServerOptions = {},
): ReturnType<typeof import("./server-start.js").startGatewayServerCore> {
  const startupStartedAt = opts.startupStartedAt ?? Date.now();
  const start = async () => {
    const mod = await loadServerStart();
    return await mod.startGatewayServerCore(port, { ...opts, startupStartedAt });
  };
  // Transferable stdio sockets are a Node contract; Bun keeps its native transport.
  if (process.platform !== "linux" || process.versions.bun) {
    return await start();
  }
  const [{ createSpawnBrokerHost }, { runWithSpawnBroker }] = await Promise.all([
    import("../process/spawn-broker/host.js"),
    import("../process/spawn-broker/context.js"),
  ]);
  let logger: { info: (message: string) => void } | undefined;
  const broker = createSpawnBrokerHost({
    onReady(pid, restarted) {
      if (restarted) {
        logger?.info(`spawn broker restarted pid=${pid}`);
      }
    },
  });
  try {
    await broker.ready();
    const { createSubsystemLogger } = await import("../logging/subsystem.js");
    logger = createSubsystemLogger("gateway");
    logger.info(`spawn broker ready pid=${broker.pid}`);
    const server = await runWithSpawnBroker(broker, start);
    return {
      ...server,
      close: (closeOptions) =>
        runWithSpawnBroker(broker, async () => {
          try {
            await server.close(closeOptions);
          } finally {
            // Process scopes and relay extinction joins finish before their transport closes.
            await broker.close();
          }
        }),
    };
  } catch (error) {
    await broker.close();
    throw error;
  }
}

/** Clears prepared model-catalog generations between tests. */
export async function resetPreparedModelCatalogForTest(): Promise<void> {
  const mod = await loadServerStart();
  await mod.resetPreparedModelCatalogForTestCore();
}
