import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar agent menu scope", () => {
  it.each([0, 1])(
    "keeps the mode toggle and agent actions with %i configured agents",
    async (count) => {
      const gateway = createGateway({} as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(
        gateway,
        createSessions("main", ["agent:main:main"]),
        "panel",
        {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: count === 0 ? [] : [{ id: "main", identity: { name: "Molty", emoji: "🦞" } }],
        },
      );
      sidebar.connected = true;
      await sidebar.updateComplete;

      sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector(".sidebar-agent-menu");
      expect(menu?.querySelector(".sidebar-customize-menu__title")).toBeNull();
      expect(menu?.querySelectorAll('[role="separator"]')).toHaveLength(2);
      expect(menu?.querySelector(".sidebar-agent-menu__filter")).toBeNull();
      expect(menu?.querySelector(".sidebar-agent-menu__agent-switch")).toBeNull();
      expect(
        [...(menu?.children ?? [])]
          .filter((element) => element.localName === "wa-dropdown-item")
          .map((element) => element.getAttribute("value")),
      ).toEqual([
        "command:all-agents",
        "command:new-agent",
        "command:capabilities",
        "command:agent-settings",
        "command:sidebar-agents",
      ]);
    },
  );

  it.each([
    { label: "Every agent", navigation: ["agents-home", undefined] },
    { label: "Agent settings", navigation: ["agents", { pathname: "/settings/agents/main" }] },
  ])("navigates to $label and closes the agent menu", async ({ label, navigation }) => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const actionRow = [
      ...sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-menu wa-dropdown-item"),
    ].find((row) => row.textContent?.includes(label));
    expect(actionRow).toBeDefined();
    actionRow?.click();
    await sidebar.updateComplete;
    expect(onNavigate).toHaveBeenCalledWith(...navigation);
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
  });

  it.each(["main", "research"])(
    "chooses %s from the workspace menu and leaves roster mode",
    async (agentId) => {
      const { sidebar, context } = await mountSidebar(
        createGatewayHarness({} as GatewayBrowserClient).gateway,
        createSessions("main", ["agent:main:main", "agent:research:main"]),
        "panel",
        TWO_AGENTS,
      );
      sidebar.activeRouteId = "skills";
      sidebar.connected = true;
      sidebar.sidebarAgentsMode = "roster";
      context.agentSelection.setScope(null);
      await sidebar.updateComplete;
      sidebar.querySelector<HTMLButtonElement>(".sidebar-workspace-header__main")?.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector(".sidebar-agent-menu")!;
      expect(
        [...menu.querySelectorAll('wa-dropdown-item[value^="agent:"]')].map((item) =>
          item.getAttribute("aria-checked"),
        ),
      ).toEqual(["false", "false"]);
      await vi.waitFor(() =>
        expect(
          menu.querySelector('[value="command:all-agents"]')?.getAttribute("aria-checked"),
        ).toBe("true"),
      );
      expect(menu.querySelector('[value="command:sidebar-agents"]')?.textContent?.trim()).toBe(
        "Sessions from every agent",
      );
      expect(
        menu.querySelector('[value="command:sidebar-agents"]')?.getAttribute("aria-checked"),
      ).toBe("true");
      expect(menu.querySelector('[value="command:help"]')).toBeNull();
      menu.querySelector<HTMLElement>(`[value="agent:${agentId}"]`)?.click();
      await sidebar.updateComplete;
      expect(sidebar.sidebarAgentsMode).toBe("chip");
      expect(sidebar.activeRouteId).toBe("skills");
      expect(context.agentSelection.state).toEqual({ selectedId: agentId, scopeId: agentId });
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      expect(sidebar.querySelector(".sidebar-agent-card__main")).not.toBeNull();
    },
  );

  it("marks Every agent when a page exposes all agents without enabling the roster", async () => {
    const { sidebar, context } = await mountSidebar(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    sidebar.activeRouteId = "skills";
    context.agentSelection.setScope(null);
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector(".sidebar-agent-menu")!;
    await vi.waitFor(() =>
      expect(menu.querySelector('[value="command:all-agents"]')?.getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(
      menu.querySelector('[value="command:sidebar-agents"]')?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      [...menu.querySelectorAll('wa-dropdown-item[value^="agent:"]')].every(
        (item) => item.getAttribute("aria-checked") === "false",
      ),
    ).toBe(true);
  });
});
