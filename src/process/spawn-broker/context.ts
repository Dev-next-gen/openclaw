import { AsyncLocalStorage } from "node:async_hooks";
import type { SpawnBrokerHost } from "./host.js";

const context = new AsyncLocalStorage<SpawnBrokerHost>();

export function runWithSpawnBroker<T>(host: SpawnBrokerHost, run: () => T): T {
  return context.run(host, run);
}

export function getSpawnBroker(): SpawnBrokerHost | undefined {
  return context.getStore();
}
