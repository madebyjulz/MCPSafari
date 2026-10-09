// Markup for the popup's two panels. Pure functions of what the background
// reported, so they can be checked without a browser.

import type { PortStatus, SiteAccess } from "../shared/popup.ts";

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** One row per port, sorted by port; or a placeholder while nothing is known. */
export const connectionsMarkup = (ports: ReadonlyArray<PortStatus>): string => {
  if (ports.length === 0) return '<div class="empty">Scanning for servers…</div>';

  return [...ports]
    .sort((a, b) => a.port - b.port)
    .map(({ port, state, manual }) => {
      const label = manual ? "" : '<span class="auto-badge">auto</span>';

      return `<div class="conn-row ${state}">
            <span class="dot"></span>
            <span class="conn-port">${port}</span>
            ${label}
            <span class="conn-state">${state}</span>
            <button class="btn-icon btn-reconnect" data-port="${port}" title="Reconnect">&#x21bb;</button>
            <button class="btn-icon btn-remove" data-port="${port}" title="Remove">&times;</button>
        </div>`;
    })
    .join("");
};

// Safari grants website access per site, and says so nowhere the user is
// looking. Saying it here means someone can tell "the agent cannot reach this
// page" from "the server is not connected", which are the two failures that
// otherwise look identical from the outside.
export const siteAccessMarkup = (access: SiteAccess | undefined): string => {
  if (!access || !access.origin) return "";

  const host = access.origin.replace(/^https?:\/\//, "");

  const state = access.allowed
    ? '<span class="site-state allowed">Allowed</span>'
    : access.pending
      ? '<span class="site-state">Asking…</span>'
      : '<span class="site-state blocked">No access</span>';

  const hint = access.allowed
    ? ""
    : access.pending
      ? '<p class="site-hint">Safari is asking whether to allow this site. Its dialog can ' +
        "open behind another window.</p>"
      : '<p class="site-hint">Allow this site from Safari Settings &gt; Extensions to let ' +
        "MCPSafari read it. Results are shared with your MCP client.</p>";

  return `<div class="site-row"><span class="site-host">${escapeHtml(host)}</span>${state}</div>${hint}`;
};
