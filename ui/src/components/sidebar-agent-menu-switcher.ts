import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type { AgentIdentityResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { renderAgentSelectAvatar, renderAgentSelectCopy } from "./agent-select.ts";
import { icons } from "./icons.ts";
import { syncDropdownItemRadio } from "./web-awesome.ts";

export const AGENT_VALUE_PREFIX = "agent:";

type AgentMenuAgent = {
  id: string;
  name?: string;
  identity?: { name?: string; emoji?: string; avatar?: string; avatarUrl?: string };
};

export type SidebarAgentMenuSwitcherParams = {
  scopeId: string | null;
  agents: readonly AgentMenuAgent[];
  identities: ReadonlyMap<string, AgentIdentityResult>;
  pinnedAgentIds: readonly string[];
  resolveAvatarUrl: (url: string) => string | null;
  avatarErrorHandler: (url: string) => () => void;
  rosterMode: boolean;
  agentUnreadCount: (agentId: string) => number;
};

function sidebarAgentMenuRows(params: {
  agents: readonly AgentMenuAgent[];
  pinnedAgentIds: readonly string[];
}) {
  const { agents } = params;
  const availableIds = new Set(agents.map((agent) => normalizeAgentId(agent.id)));
  const pinnedIds = new Set(
    params.pinnedAgentIds
      .map((agentId) => normalizeAgentId(agentId))
      .filter((agentId) => availableIds.has(agentId)),
  );
  return agents.toSorted((a, b) => {
    const aPinned = pinnedIds.has(normalizeAgentId(a.id)) ? 0 : 1;
    const bPinned = pinnedIds.has(normalizeAgentId(b.id)) ? 0 : 1;
    return aPinned - bPinned;
  });
}

function renderAgentRow(agent: AgentMenuAgent, params: SidebarAgentMenuSwitcherParams) {
  const agentId = normalizeAgentId(agent.id);
  const identity = params.identities.get(agentId) ?? null;
  const label = normalizeAgentLabel(agent, identity);
  const active = !params.rosterMode && agentId === params.scopeId;
  const unread = active ? 0 : params.agentUnreadCount(agentId);
  const option = { value: agentId, label, agent };
  const avatarUrl = resolveAgentAvatarUrl(agent, identity);
  const resolvedAvatarUrl = avatarUrl ? params.resolveAvatarUrl(avatarUrl) : null;
  return html`
    <wa-dropdown-item
      class="sidebar-customize-menu__item sidebar-agent-menu__agent-switch agent-select__option ${
        active ? "sidebar-agent-menu__agent-switch--active" : ""
      }"
      value=${`${AGENT_VALUE_PREFIX}${encodeURIComponent(agentId)}`}
      type="checkbox"
      role="menuitemradio"
      aria-checked=${String(active)}
      ${ref((element) => syncDropdownItemRadio(element, active))}
    >
      <span class="sidebar-agent-menu__agent-tile">
        <span class="sidebar-agent-menu__agent-avatar">
          ${renderAgentSelectAvatar(
            option,
            identity,
            resolvedAvatarUrl,
            avatarUrl ? params.avatarErrorHandler(avatarUrl) : undefined,
          )}
        </span>
        ${renderAgentSelectCopy(option)}
        <span class="sidebar-agent-menu__agent-status">
          ${active ? html`<span class="session-menu__check" aria-hidden="true">${icons.check}</span>` : nothing}
          ${
            unread > 0
              ? html`<span
                  class="session-unread-dot"
                  role="img"
                  aria-label=${t("sessionsView.unread")}
                ></span>`
              : nothing
          }
        </span>
      </span>
    </wa-dropdown-item>
  `;
}

export function renderSidebarAgentMenuSwitcher(params: SidebarAgentMenuSwitcherParams) {
  return html`
    ${
      params.agents.length > 1
        ? html`
            <div class="sidebar-customize-menu__title">${t("agentChip.agents")}</div>
            <div class="sidebar-agent-menu__agent-grid">
              ${sidebarAgentMenuRows(params).map((entry) => renderAgentRow(entry, params))}
            </div>
          `
        : nothing
    }
  `;
}
