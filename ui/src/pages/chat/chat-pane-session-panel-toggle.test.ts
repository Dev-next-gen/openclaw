import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiLinkReaderDescriptor } from "../../../../src/shared/control-ui-link-reader.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { LINK_READER_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import {
  rememberSessionPanelToggle,
  type SessionPanelToggleSlot,
} from "../../components/session-panel-toggle-buffer.ts";
import { ChatPaneSessionPanelToggleController } from "./chat-pane-session-panel-toggle.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";

const reader: ControlUiLinkReaderDescriptor = {
  pluginId: "forge",
  id: "items",
  label: "Forge",
  linkReader: {
    hosts: ["forge.example"],
    pathPattern: "^/items/[0-9]+$",
    detailMethod: "forge.item",
  },
};

function fixture() {
  const definitions = createDeferred<CustomElementConstructor>();
  const commit = createDeferred<boolean>();
  vi.spyOn(customElements, "whenDefined").mockReturnValue(definitions.promise);
  const region = document.createElement("div");
  const deliverPanelEvent = vi.fn();
  Object.assign(region, { updateComplete: commit.promise, deliverPanelEvent });
  const root = document.createElement("div");
  vi.spyOn(root, "querySelector").mockReturnValue(region);
  const state = createPageState(
    createInitializationContext(),
    { invalidate: vi.fn(), afterCommit: () => () => {} },
    root,
  );
  state.connected = true;
  state.client = createGatewayBrowserClientFixture();
  state.sessionKey = "session-a";
  state.sidebarLayout = { columns: [] };
  const owner = {
    renderRoot: root,
    state,
    linkReaders: [reader],
    updateComplete: Promise.resolve(),
  };
  const pending = new Map<SessionPanelToggleSlot, Event>();
  const requestUpdate = vi.fn();
  const updateSidebarLayout = vi.fn((layout: ChatPageHost["sidebarLayout"]) => {
    state.sidebarLayout = layout;
  });
  const controller = new ChatPaneSessionPanelToggleController({
    current: () => owner,
    pending,
    requestUpdate,
    updateSidebarLayout,
  });
  const event = (url = "https://forge.example/items/1") =>
    new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      cancelable: true,
      detail: { url, open: true },
    });
  return {
    controller,
    definitions,
    commit,
    deliverPanelEvent,
    event,
    owner,
    pending,
    state,
    updateSidebarLayout,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("session link-reader intent delivery", () => {
  it("keeps unsupported URLs unaccepted and leaves the layout alone", () => {
    const f = fixture();
    const event = f.event("https://example.com/ordinary-link");
    expect(f.controller.handle("link-reader", "openclaw-link-reader-panel", event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(f.updateSidebarLayout).not.toHaveBeenCalled();
  });

  it("accepts a buffered link, opens its shared slot, and delivers only after lazy commits", async () => {
    const f = fixture();
    const event = f.event();
    rememberSessionPanelToggle("link-reader", event);
    f.controller.flush();
    expect(event.defaultPrevented).toBe(true);
    expect(f.state.sidebarLayout.columns[0]?.panels).toEqual([
      { id: "link-reader", slot: "link-reader" },
    ]);
    expect(f.deliverPanelEvent).not.toHaveBeenCalled();
    f.definitions.resolve(HTMLElement);
    await Promise.resolve();
    expect(f.deliverPanelEvent).not.toHaveBeenCalled();
    f.commit.resolve(true);
    await vi.waitFor(() => expect(f.deliverPanelEvent).toHaveBeenCalledWith("link-reader", event));
    expect(f.pending.size).toBe(0);
  });

  it.each(["session", "close", "capability"] as const)(
    "does not deliver after %s changes during the region commit",
    async (change) => {
      const f = fixture();
      f.controller.handle("link-reader", "openclaw-link-reader-panel", f.event());
      f.definitions.resolve(HTMLElement);
      await Promise.resolve();
      await Promise.resolve();
      if (change === "session") {
        f.state.sessionKey = "session-b";
      }
      if (change === "capability") {
        f.owner.linkReaders = [];
      }
      if (change === "close") {
        f.controller.handle(
          "link-reader",
          "openclaw-link-reader-panel",
          new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, { detail: { open: false } }),
        );
      }
      f.commit.resolve(true);
      await f.commit.promise;
      await Promise.resolve();
      await Promise.resolve();
      expect(f.deliverPanelEvent).not.toHaveBeenCalled();
    },
  );
});
