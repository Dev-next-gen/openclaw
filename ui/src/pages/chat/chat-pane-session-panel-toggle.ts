import type { ControlUiLinkReaderDescriptor } from "../../../../src/shared/control-ui-link-reader.js";
import { resolveLinkReaderTarget } from "../../components/link-reader-target.ts";
import {
  clearSessionPanelToggle,
  takeSessionPanelToggle,
  type SessionPanelToggleSlot,
} from "../../components/session-panel-toggle-buffer.ts";
import {
  terminalIntentQueue,
  terminalToggleIntent,
} from "../../components/terminal/terminal-pending-actions.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { closeSlot, openSlot } from "./sidebar-layout.ts";

type PanelTagName =
  | "openclaw-link-reader-panel"
  | "openclaw-browser-panel"
  | "openclaw-desktop-panel"
  | "openclaw-terminal-panel";

interface ActivePanelOwner {
  renderRoot: ParentNode;
  state: ChatPageHost;
  linkReaders: readonly ControlUiLinkReaderDescriptor[];
  updateComplete: Promise<unknown>;
}

interface SessionPanelToggleControllerOptions {
  current: () => ActivePanelOwner | null;
  pending: Map<SessionPanelToggleSlot, Event>;
  requestUpdate: () => void;
  updateSidebarLayout: (layout: ChatPageHost["sidebarLayout"]) => void;
}

/** Owns shell-to-pane panel intent handoff for the active chat presentation. */
export class ChatPaneSessionPanelToggleController {
  constructor(private readonly options: SessionPanelToggleControllerOptions) {}

  handle(slot: SessionPanelToggleSlot, tagName: PanelTagName, event: Event): boolean {
    const owner = this.options.current();
    if (!owner) {
      return false;
    }
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (
      slot === "link-reader" &&
      detail?.open !== false &&
      (!owner.state.connected ||
        !owner.state.client ||
        owner.linkReaders.length === 0 ||
        (detail?.url !== undefined && !resolveLinkReaderTarget(detail.url, owner.linkReaders)))
    ) {
      clearSessionPanelToggle(slot, event);
      return false;
    }
    clearSessionPanelToggle(slot, event);
    if (slot === "link-reader") {
      event.preventDefault();
    }
    if (detail?.open === false) {
      this.options.pending.delete(slot);
      this.options.updateSidebarLayout(closeSlot(owner.state.sidebarLayout, slot));
      return true;
    }
    if (slot === "terminal") {
      const intent = terminalToggleIntent(event, resolveChatAgentId(owner.state));
      const embeddedTerminal = owner.renderRoot.querySelector("openclaw-terminal-panel[embedded]");
      const terminalConstructor = customElements.get("openclaw-terminal-panel");
      const embeddedTerminalMounted =
        embeddedTerminal !== null &&
        terminalConstructor !== undefined &&
        embeddedTerminal instanceof terminalConstructor;
      if (intent) {
        void terminalIntentQueue.queue(intent, {
          deferUntilHostChange: !embeddedTerminalMounted,
        });
      }
      this.options.updateSidebarLayout(openSlot(owner.state.sidebarLayout, slot));
      return true;
    }
    const sessionKey = owner.state.sessionKey;
    const isCurrent = () =>
      this.options.pending.get(slot) === event &&
      this.options.current()?.state === owner.state &&
      owner.state.sessionKey === sessionKey;
    this.options.pending.set(slot, event);
    this.options.updateSidebarLayout(openSlot(owner.state.sidebarLayout, slot));
    void Promise.all([
      customElements.whenDefined("openclaw-chat-sidebar-region"),
      customElements.whenDefined(tagName),
    ]).then(async () => {
      this.options.requestUpdate();
      await this.options.current()?.updateComplete;
      if (!isCurrent()) {
        return;
      }
      const region = owner.renderRoot.querySelector<
        HTMLElementTagNameMap["openclaw-chat-sidebar-region"]
      >("openclaw-chat-sidebar-region");
      await region?.updateComplete;
      if (!isCurrent()) {
        return;
      }
      const current = this.options.current();
      if (
        slot === "link-reader" &&
        (!current?.state.connected ||
          !current.state.client ||
          current.linkReaders.length === 0 ||
          (detail?.url !== undefined && !resolveLinkReaderTarget(detail.url, current.linkReaders)))
      ) {
        this.options.pending.delete(slot);
        return;
      }
      region?.deliverPanelEvent(slot, event);
      this.options.pending.delete(slot);
      this.options.requestUpdate();
    });
    return true;
  }

  flush(): void {
    if (!this.options.current()) {
      return;
    }
    for (const [slot, tagName] of [
      ["terminal", "openclaw-terminal-panel"],
      ["browser", "openclaw-browser-panel"],
      ["link-reader", "openclaw-link-reader-panel"],
      ["desktop", "openclaw-desktop-panel"],
    ] as const) {
      const event = takeSessionPanelToggle(slot);
      if (event) {
        this.handle(slot, tagName, event);
      }
    }
  }
}
