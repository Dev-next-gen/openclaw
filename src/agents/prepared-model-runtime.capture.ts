import type { Model } from "../llm/types.js";
import { copyPreparedModelRuntimeAuthBindings } from "./prepared-model-runtime-auth.js";
import { mergePreparedNativeCatalog } from "./prepared-model-runtime.full-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const catalogRouteMemos = new WeakMap<
  PreparedModelRuntimeSnapshot,
  {
    models: ReadonlyMap<string, readonly Model[]>;
    memo: Map<string, Promise<Model>>;
  }
>();

/** Captures published executable and native model facts without changing any open lease. */
export function capturePreparedModelRuntimeCatalog(
  snapshot: PreparedModelRuntimeSnapshot,
  source: PreparedModelRuntimeSnapshot | undefined,
): PreparedModelRuntimeSnapshot {
  const models = source?.readPublishedModels?.();
  const catalog = source?.readFullModelCatalog?.();
  const nativeCatalog =
    catalog &&
    (catalog.entries.some((entry) => entry.nativeRuntime) ||
      catalog.routeVariants.some((entry) => entry.nativeRuntime));
  const capturedNative = nativeCatalog
    ? Object.freeze({
        ...snapshot,
        modelCatalog: mergePreparedNativeCatalog(catalog, snapshot.modelCatalog),
      })
    : snapshot;
  if (!models?.size) {
    if (capturedNative !== snapshot) {
      copyPreparedModelRuntimeAuthBindings(snapshot, capturedNative);
    }
    return capturedNative;
  }
  let cached = catalogRouteMemos.get(snapshot);
  if (!cached || cached.models !== models) {
    cached = { models, memo: new Map() };
    catalogRouteMemos.set(snapshot, cached);
  }
  const stores = snapshot.createStores();
  const credentials = stores.authStorage.getAll();
  const registry = stores.modelRegistry.fork(stores.authStorage, models);
  const captured: PreparedModelRuntimeSnapshot = Object.freeze({
    ...capturedNative,
    readPublishedModels: () => models,
    routeModelResolutionMemo: cached.memo,
    createStores: () => {
      const authStorage = AuthStorage.inMemory(credentials);
      return { authStorage, modelRegistry: registry.fork(authStorage) };
    },
  });
  copyPreparedModelRuntimeAuthBindings(snapshot, captured);
  return captured;
}
