import { type MenuFrame, type MenuTask, taskStatuses } from "../shared/state";
import type { PaseoAgent } from "./paseo";

// Never forward permission payloads, error bodies, prompts, usage, or absolute paths to the UI.
export function cleanText(value: string, limit = 120): string {
  return Array.from(
    value
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, limit)
    .join("");
}

export function taskFromAgent(
  agent: PaseoAgent & { background?: boolean },
  serverId?: string,
): MenuTask | null {
  // Newer hosts expose background helpers separately from the legacy internal marker.
  if (agent.archivedAt || agent.internal || agent.background || agent.status === "closed")
    return null;
  const attention = agent.requiresAttention === true ? agent.attentionReason : null;
  const status =
    agent.pendingPermissions.length > 0 || attention === "permission"
      ? "permission"
      : agent.status === "error" || agent.providerUnavailable || attention === "error"
        ? "error"
        : agent.status === "running" || agent.activeTurn
          ? "running"
          : agent.status === "initializing"
            ? "initializing"
            : attention === "finished"
              ? "done"
              : "idle";
  const parsedStart = agent.activeTurn?.startedAt
    ? Date.parse(agent.activeTurn.startedAt)
    : Number.NaN;
  return {
    id: agent.id,
    title: cleanText(agent.title ?? "") || `未命名任务 ${cleanText(agent.id, 8)}`,
    provider: cleanText(agent.provider, 40),
    project: cleanText(agent.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "", 60),
    status,
    updatedAt: Date.parse(agent.updatedAt) || 0,
    startedAt: Number.isFinite(parsedStart) ? parsedStart : null,
    url: serverId
      ? `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agent.id)}`
      : null,
  };
}

export function makeFrame(
  tasks: Iterable<MenuTask>,
  connection: MenuFrame["connection"],
  message = "",
  now = Date.now(),
  limit = 100,
): MenuFrame {
  const counts: MenuFrame["counts"] = {
    permission: 0,
    error: 0,
    running: 0,
    initializing: 0,
    done: 0,
    idle: 0,
  };
  const sorted = [...tasks].sort(
    (a, b) =>
      taskStatuses.indexOf(a.status) - taskStatuses.indexOf(b.status) ||
      b.updatedAt - a.updatedAt ||
      a.id.localeCompare(b.id),
  );
  for (const task of sorted) counts[task.status]++;
  return {
    version: 1,
    connection,
    message,
    updatedAt: now,
    counts,
    tasks: sorted.slice(0, limit),
    omitted: Math.max(0, sorted.length - limit),
  };
}
