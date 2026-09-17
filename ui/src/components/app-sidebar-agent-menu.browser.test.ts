import { afterEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../test-helpers/load-styles.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("sidebar agent menu layout", () => {
  it("centers short and wrapped names under active and inactive avatars", async () => {
    await import("./app-sidebar.ts");
    const { createGatewayHarness, createSessions, mountSidebar } =
      await import("../test-helpers/app-sidebar.ts");
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Molty" },
          { id: "release", name: "Release reviewer" },
          { id: "research", name: "Research planning and documentation assistant" },
          { id: "scout", name: "Scout" },
        ],
      },
    );
    sidebar.connected = true;
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;

    const tiles = Array.from(
      sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-menu__agent-switch"),
    );
    expect(tiles).toHaveLength(4);
    await expect
      .poll(() => tiles.map((tile) => tile.getAttribute("aria-checked")))
      .toEqual(["true", "false", "false", "false"]);
    await document.fonts.ready;
    for (const tile of tiles) {
      const avatar = tile.querySelector<HTMLElement>(".sidebar-agent-menu__agent-avatar")!;
      const label = tile.querySelector<HTMLElement>(".agent-select__option-label")!;
      await expect.poll(() => avatar.getBoundingClientRect().width).toBeGreaterThan(0);
      const avatarBox = avatar.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      expect(
        Math.abs(labelBox.x + labelBox.width / 2 - (avatarBox.x + avatarBox.width / 2)),
        label.textContent ?? "agent name",
      ).toBeLessThanOrEqual(1);
    }
  });

  it("matches workspace and agent header geometry with a static workspace mark", async () => {
    await import("./app-sidebar.ts");
    await import("./sidebar-agent-roster.ts");
    const { createGatewayHarness, createSessions, mountSidebar } =
      await import("../test-helpers/app-sidebar.ts");
    const { sidebar } = await mountSidebar(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "OpenClaw" },
          { id: "research", name: "Research" },
        ],
      },
    );
    await document.fonts.ready;
    const measure = (header: HTMLElement, avatarSelector: string) => {
      const avatar = header.querySelector<HTMLElement>(avatarSelector)!.getBoundingClientRect();
      const name = header
        .querySelector<HTMLElement>(".sidebar-agent-card__name-text")!
        .getBoundingClientRect();
      const chevron = header
        .querySelector<HTMLElement>(".sidebar-agent-card__chevron")!
        .getBoundingClientRect();
      return [
        avatar.width,
        avatar.height,
        name.x - avatar.right,
        chevron.x - name.right,
        name.y + name.height / 2 - (avatar.y + avatar.height / 2),
        chevron.y + chevron.height / 2 - (avatar.y + avatar.height / 2),
      ];
    };
    const agent = measure(
      sidebar.querySelector<HTMLElement>(".sidebar-agent-card__main")!,
      ".sidebar-agent-card__avatar",
    );
    sidebar.sidebarAgentsMode = "roster";
    await sidebar.updateComplete;
    const workspaceHeader = sidebar.querySelector<HTMLElement>(".sidebar-workspace-header__main")!;
    const workspace = measure(workspaceHeader, ".sidebar-workspace-header__mark");
    for (const [index, dimension] of agent.entries()) {
      expect(Math.abs(workspace[index]! - dimension)).toBeLessThanOrEqual(1);
    }
    const mark = workspaceHeader.querySelector(".sidebar-workspace-header__mark")!;
    expect(mark.querySelector("svg")).not.toBeNull();
    expect(mark.querySelector("animate, animateTransform")).toBeNull();
    expect(mark.getAnimations({ subtree: true })).toHaveLength(0);
  });
});
