import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DiagnosticModelRuntimeChoiceEvent } from "../infra/diagnostic-control-plane-events.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { modelKey } from "./model-ref-shared.js";
import { resolveProviderModelMaterializationAuthMode } from "./provider-model-route-auth.js";

type RuntimeChoiceDecision = DiagnosticModelRuntimeChoiceEvent extends infer Event
  ? Event extends DiagnosticModelRuntimeChoiceEvent
    ? Pick<Event, "phase" | "outcome" | "reason">
    : never
  : never;

/** Bind runtime selection and its commit check to the current published model owner. */
export async function preparePublishedModelRuntimeChoice(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  runtimeId: string;
  sessionEntry?: Pick<
    SessionEntry,
    "authProfileOverride" | "authProfileOverrideSource" | "providerOverride" | "modelProvider"
  >;
}): Promise<
  { kind: "unavailable"; message: string } | { kind: "ready"; validate: () => string | undefined }
> {
  const { getPublishedPreparedModelCatalogOwnerSnapshot, materializePreparedModelCatalogOwner } =
    await import("./prepared-model-catalog.js");
  const { getPreparedModelRuntimeAuthStore } = await import("./prepared-model-runtime-auth.js");
  const { createModelCatalogDecisions } = await import("./model-catalog-decisions.js");
  const checks: DiagnosticModelRuntimeChoiceEvent["checks"] = {
    ownerLookup: "not-reached",
    authStore: "not-reached",
    catalogPresence: "not-reached",
    offCatalogAuth: "not-reached",
    offCatalogAuthMode: "not-reached",
    offCatalogResolution: "not-reached",
    runtimeEligibility: "not-reached",
    commitOwnerFreshness: "not-reached",
    nativeAvailability: "not-reached",
  };
  const record = (decision: RuntimeChoiceDecision) => {
    emitTrustedDiagnosticEvent({
      type: "model.runtime_choice",
      version: 1,
      ...decision,
      // The dispatcher queues delivery. Each invocation owns an immutable snapshot.
      checks: { ...checks },
    });
  };
  const reject = (
    reason: Extract<
      DiagnosticModelRuntimeChoiceEvent,
      { phase: "prepare"; outcome: "unavailable" }
    >["reason"],
  ) => {
    record({ phase: "prepare", outcome: "unavailable", reason });
    return { kind: "unavailable" as const, message: unavailable };
  };
  const published = getPublishedPreparedModelCatalogOwnerSnapshot({
    config: params.cfg,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
  });
  const unavailable = `Runtime "${params.runtimeId}" is not available for ${params.provider}/${params.model}. Refresh the model catalog and choose again.`;
  checks.ownerLookup = published ? "present" : "absent";
  if (!published) {
    return reject("owner-missing");
  }
  const owner = materializePreparedModelCatalogOwner(published);
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  checks.authStore = authStore ? "present" : "absent";
  if (!authStore) {
    return reject("auth-store-missing");
  }
  const decisions = createModelCatalogDecisions({
    cfg: owner.config,
    agentId: owner.agentId ?? params.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    snapshot: owner.modelCatalog,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: authStore,
    preparedRuntimeAuthModes: owner.authModes,
    pluginRegistry: owner.pluginRegistry,
    observationConfig: owner.observationConfig,
    isCurrent: owner.isCurrent,
    preferredProfileId: params.sessionEntry?.authProfileOverride,
    pinnedProfileId:
      params.sessionEntry?.authProfileOverrideSource === "user"
        ? params.sessionEntry.authProfileOverride
        : undefined,
    profileProvider: params.sessionEntry?.providerOverride ?? params.sessionEntry?.modelProvider,
  });
  let entry = decisions.snapshot.entries.find(
    (row) => modelKey(row.provider, row.id) === modelKey(params.provider, params.model),
  );
  checks.catalogPresence = entry ? "present" : "absent";
  if (!entry) {
    // Explicit selections may be outside finite browse inventory. The normal
    // resolver still owns the requested model's provider and physical route.
    const { resolveModelAsync } = await import("./embedded-agent-runner/model.js");
    const { modelCatalogRowToEntry } = await import("./model-catalog-entry.js");
    const selectedAuth = await decisions.evaluateEntry(
      { provider: params.provider, id: params.model },
      undefined,
      params.runtimeId,
    );
    const authProfileMode = resolveProviderModelMaterializationAuthMode(
      selectedAuth.selectedAuthMode,
    );
    checks.offCatalogAuth = selectedAuth.availability === true ? "available" : "unavailable";
    checks.offCatalogAuthMode = authProfileMode ? "available" : "unavailable";
    if (selectedAuth.availability !== true || !authProfileMode) {
      return reject(
        selectedAuth.availability !== true
          ? "off-catalog-auth-unavailable"
          : "off-catalog-auth-mode-unavailable",
      );
    }
    const resolved = await resolveModelAsync(
      params.provider,
      params.model,
      owner.agentDir,
      owner.config,
      {
        agentId: owner.agentId ?? params.agentId,
        workspaceDir: owner.workspaceDir,
        preparedModelRuntime: owner,
        agentRuntimeId: params.runtimeId,
        allowBundledStaticCatalogFallback: true,
        // Discovery must retain the prepared account instead of rereading live auth stores.
        authProfileMode,
        ...(selectedAuth.selectedProfileId
          ? { authProfileId: selectedAuth.selectedProfileId }
          : {}),
      },
    );
    checks.offCatalogResolution = resolved.model ? "resolved" : "unresolved";
    if (!resolved.model) {
      return reject("off-catalog-resolution-unavailable");
    }
    entry = modelCatalogRowToEntry(resolved.model);
  }
  const variants = decisions.snapshot.routeVariants.filter(
    (row) => modelKey(row.provider, row.id) === modelKey(entry.provider, entry.id),
  );
  const choices = await decisions.runtimeChoices(entry, variants.length ? variants : [entry]);
  const eligible = choices?.includes(params.runtimeId);
  checks.runtimeEligibility = eligible ? "eligible" : "ineligible";
  if (!eligible) {
    return reject("runtime-ineligible");
  }
  const host = await decisions.evaluateEntry(
    entry,
    variants.length ? variants : [entry],
    params.runtimeId,
  );
  const validate = () => {
    const current = decisions.isCurrent();
    checks.commitOwnerFreshness = current ? "current" : "stale";
    // Preserve the owner guard's short circuit, including on repeated validation.
    checks.nativeAvailability = "not-reached";
    if (!current) {
      record({ phase: "validate", outcome: "unavailable", reason: "owner-stale" });
      return unavailable;
    }
    const available = decisions.evaluateNative(entry, host, params.runtimeId).availability === true;
    checks.nativeAvailability = available ? "available" : "unavailable";
    record(
      available
        ? { phase: "validate", outcome: "ready", reason: "ready" }
        : { phase: "validate", outcome: "unavailable", reason: "native-unavailable" },
    );
    return available ? undefined : unavailable;
  };

  record({ phase: "prepare", outcome: "ready", reason: "ready" });
  return { kind: "ready", validate };
}
