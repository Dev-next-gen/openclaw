import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { renderModelPicker } from "../../components/model-picker.ts";
import { providerDisplayLabel } from "../../components/provider-icon.ts";
import { t } from "../../i18n/index.ts";
import {
  loadModelCatalog,
  modelCatalogRefreshError,
  subscribeModelCatalogChanges,
} from "../../lib/model-catalog-store.ts";
import { readSessionDefaults } from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { captureModelSetupConnection, modelSetupAgentSelection } from "./first-run-setup.ts";
import { formatModelSetupError } from "./model-setup-task-result.ts";

class NativeModelSetup extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @property({ type: Boolean }) firstRun = false;
  @property({ type: Boolean }) blocked = false;
  @state() private nativeModels: ModelCatalogEntry[] = [];
  @state() private nativeModel = "";
  @state() private nativeModelError: string | null = null;
  @state() private nativeModelSaving = false;
  private nativeModelsAbort: AbortController | null = null;
  private nativeModelsUnsubscribe: (() => void) | null = null;
  @state() private nativeModelsStatus: "idle" | "loading" | "ready" = "idle";
  private observedConnection: ReturnType<typeof captureModelSetupConnection> | null = null;
  private get agentSelection() {
    return modelSetupAgentSelection(this.context, this.firstRun);
  }
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      () => this.synchronize(),
    )
    .watch(
      () => this.context && this.agentSelection,
      (selection, notify) => selection.subscribe(notify),
      () => this.synchronize(),
    );

  override willUpdate() {
    this.synchronize();
  }
  override disconnectedCallback() {
    this.observedConnection = null;
    this.reset();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }
  private synchronize() {
    if (!this.isConnected || !this.context) {
      return;
    }
    const previous = this.observedConnection;
    const next = captureModelSetupConnection(this.context, this.firstRun, previous?.recoveryScope);
    if (
      previous &&
      next.client === previous.client &&
      next.hello === previous.hello &&
      next.agentId === previous.agentId &&
      next.connected === previous.connected &&
      next.firstRun === previous.firstRun &&
      next.connectionRevision === previous.connectionRevision &&
      next.recoveryScope === previous.recoveryScope
    ) {
      return;
    }
    this.observedConnection = next;
    this.reset();
  }
  private reset() {
    this.nativeModels = [];
    this.nativeModel = "";
    this.nativeModelError = null;
    this.nativeModelSaving = false;
    this.nativeModelsAbort?.abort();
    this.nativeModelsAbort = null;
    this.nativeModelsUnsubscribe?.();
    this.nativeModelsUnsubscribe = null;
    this.nativeModelsStatus = "idle";
    this.publishState();
  }
  private publishState() {
    this.dispatchEvent(
      new CustomEvent("native-model-state", {
        bubbles: true,
        composed: true,
        detail: { count: this.nativeModels.length, saving: this.nativeModelSaving },
      }),
    );
  }
  private canUseSetup(client: GatewayBrowserClient | null): client is GatewayBrowserClient {
    const snapshot = this.context.gateway.snapshot;
    return Boolean(
      client &&
      snapshot.client === client &&
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      (this.firstRun || this.agentSelection.state.selectedId !== null),
    );
  }
  private async useNativeModel(): Promise<void> {
    const connection = this.observedConnection;
    const client = this.context.gateway.snapshot.client;
    const agentId =
      this.agentSelection.state.selectedId ??
      readSessionDefaults(this.context.gateway.snapshot)?.defaultAgentId;
    const model = this.nativeModels.find(
      (entry) => `${entry.provider}/${entry.id}` === this.nativeModel,
    );
    if (
      !this.canUseSetup(client) ||
      !agentId ||
      model?.available !== true ||
      this.nativeModelSaving ||
      this.blocked
    ) {
      return;
    }
    this.nativeModelSaving = true;
    this.publishState();
    this.nativeModelError = null;
    const modelRef = `${model.provider}/${model.id}`;
    try {
      const mutation = await this.context.runtimeConfig.runExternalMutation(
        (mutationClient) =>
          mutationClient.request("agents.update", {
            agentId,
            model: modelRef,
            agentRuntime: model.agentRuntime?.id,
          }),
        { canDispatch: () => this.observedConnection === connection && this.canUseSetup(client) },
      );
      if (this.observedConnection !== connection) {
        return;
      }
      if (!mutation.ok) {
        this.nativeModelError = mutation.error;
        return;
      }
      if (!mutation.refresh.ok) {
        this.nativeModelError = mutation.refresh.error;
        return;
      }
      await this.context.agents.refreshList();
      if (this.observedConnection === connection) {
        this.context.navigate("chat");
      }
    } catch (error) {
      if (this.observedConnection === connection) {
        this.nativeModelError = formatModelSetupError(error);
      }
    } finally {
      if (this.observedConnection === connection) {
        this.nativeModelSaving = false;
        this.publishState();
      }
    }
  }

  private async loadNativeModels(refresh = true): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canUseSetup(client)) {
      return;
    }
    const scope = {
      view: "all" as const,
      agentId: this.agentSelection.state.selectedId ?? undefined,
    };
    this.nativeModelsUnsubscribe ??= subscribeModelCatalogChanges(
      this.context.gateway,
      () => void this.loadNativeModels(false),
      scope,
    );
    const connection = this.observedConnection;
    this.nativeModelsAbort?.abort();
    const controller = new AbortController();
    this.nativeModelsAbort = controller;
    this.nativeModelError = null;
    this.nativeModelsStatus = "loading";
    try {
      const catalog = await loadModelCatalog(client, {
        ...scope,
        refresh,
        signal: controller.signal,
      });
      if (this.observedConnection !== connection || controller.signal.aborted) {
        return;
      }
      this.nativeModels = catalog.models.filter(
        (model) =>
          model.agentRuntime &&
          model.agentRuntime.id !== "openclaw" &&
          model.apiKeySupported === false,
      );
      this.nativeModelsStatus = catalog.pendingProviders?.length ? "loading" : "ready";
      this.nativeModelError = modelCatalogRefreshError(catalog);
      if (
        !this.nativeModels.some((model) => `${model.provider}/${model.id}` === this.nativeModel)
      ) {
        this.nativeModel = "";
      }
    } catch (error) {
      if (this.observedConnection === connection && !controller.signal.aborted) {
        this.nativeModelsStatus = "ready";
        this.nativeModelError = formatModelSetupError(error);
      }
    } finally {
      if (this.nativeModelsAbort === controller) {
        this.nativeModelsAbort = null;
        this.publishState();
      }
    }
  }

  override render() {
    const models = this.nativeModels;
    const selected = models.find((model) => `${model.provider}/${model.id}` === this.nativeModel);
    return html`
      <section class="settings-section" data-native-model-setup>
        <div class="settings-section__header"><h2>${t("modelSetup.nativeModels.title")}</h2></div>
        <p class="muted">${t("modelSetup.nativeModels.body")}</p>
        ${this.nativeModelsStatus === "loading" ? html`<p role="status">${t("modelSetup.nativeModels.loading")}</p>` : nothing}
        ${this.nativeModelsStatus === "ready" && models.length === 0 && !this.nativeModelError ? html`<p role="status">${t("modelSetup.nativeModels.empty")}</p>` : nothing}
        ${renderModelPicker({
          label: t("modelSetup.nativeModels.choose"),
          value: this.nativeModel,
          options: models.map((model) => ({
            value: `${model.provider}/${model.id}`,
            label: model.name,
            provider: model.provider,
            detail:
              model.available === true
                ? providerDisplayLabel(model.provider)
                : t("modelSetup.nativeModels.signIn"),
            disabled: model.available !== true,
          })),
          disabled: this.blocked || this.nativeModelSaving,
          onChange: (value) => (this.nativeModel = value),
          onOpen: () => void this.loadNativeModels(),
        })}
        <button
          class="btn primary"
          ?disabled=${this.blocked || this.nativeModelSaving || selected?.available !== true}
          @click=${() => void this.useNativeModel()}
        >
          ${t(this.nativeModelSaving ? "modelSetup.nativeModels.saving" : "modelSetup.nativeModels.use")}
        </button>
        ${this.nativeModelError ? html`<div class="callout danger" role="alert">${this.nativeModelError}</div>` : nothing}
      </section>
    `;
  }
}

if (!customElements.get("openclaw-native-model-setup")) {
  customElements.define("openclaw-native-model-setup", NativeModelSetup);
}

export function renderNativeModelSetup(
  firstRun: boolean,
  blocked: boolean,
  onStateChange?: (state: { count: number; saving: boolean }) => void,
) {
  return html`<openclaw-native-model-setup
    .firstRun=${firstRun}
    .blocked=${blocked}
    @native-model-state=${(event: CustomEvent<{ count: number; saving: boolean }>) => onStateChange?.(event.detail)}
  ></openclaw-native-model-setup>`;
}
