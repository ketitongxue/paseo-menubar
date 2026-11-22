import {
  type MenuFrame,
  type MenuTask,
  type MenuUsage,
  type MenuUsageAccount,
  type MenuUsageBalance,
  type MenuUsageWindow,
  taskStatuses,
  type UsageAccountStatus,
  type UsageBalanceUnit,
  type UsageTone,
  usageAccountStatuses,
  usageBalanceUnits,
  usageTones,
} from "../shared/state";
import type { PaseoAgent, PaseoProviderUsage, PaseoProviderUsageResult } from "./paseo";

const MIN_VALID_RESET_EPOCH_MS = Date.UTC(2000, 0, 1);

// Never forward permission payloads, raw error bodies, prompts, or absolute paths to the UI.
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

function clampPct(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const clamped = Math.max(0, Math.min(100, value));
  return Math.round(clamped * 10) / 10;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseResetTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= MIN_VALID_RESET_EPOCH_MS ? parsed : null;
}

function normalizeTone(tone: string | undefined, usedPct: number | null): UsageTone {
  if (tone && (usageTones as readonly string[]).includes(tone)) return tone as UsageTone;
  if (usedPct === null) return "default";
  if (usedPct >= 90) return "danger";
  if (usedPct >= 75) return "warning";
  return "ok";
}

function normalizeUnit(unit: string | undefined): UsageBalanceUnit | null {
  if (unit && (usageBalanceUnits as readonly string[]).includes(unit))
    return unit as UsageBalanceUnit;
  return null;
}

// Classify known host-generated status strings into safe UI labels; never pass raw error bodies.
function safeUsageAccountMessage(
  status: UsageAccountStatus,
  rawError: string | null | undefined,
): string {
  if (status === "available") return "";
  if (status === "unavailable") {
    if (rawError && /^Login rejected\b/i.test(rawError)) return "登录已失效，请在 Paseo 重新登录";
    if (rawError && /^Login expired\b/i.test(rawError)) return "登录已过期，请在 Paseo 重新登录";
    return "账号暂不可用，请在 Paseo 查看";
  }
  return "额度查询失败，请在 Paseo 查看";
}

export function initialUsage(): MenuUsage {
  return {
    status: "idle",
    message: "",
    fetchedAt: null,
    accounts: [],
    omitted: 0,
  };
}

export function usageAccountFromProvider(provider: PaseoProviderUsage): MenuUsageAccount {
  const status: UsageAccountStatus = (usageAccountStatuses as readonly string[]).includes(
    provider.status,
  )
    ? (provider.status as UsageAccountStatus)
    : "error";
  const windows: MenuUsageWindow[] =
    status === "available"
      ? (provider.windows ?? []).slice(0, 20).map((entry, index) => {
          const rawUsed = clampPct(entry.usedPct);
          const rawRemaining = clampPct(entry.remainingPct);
          const usedPct = rawUsed ?? (rawRemaining === null ? null : clampPct(100 - rawRemaining));
          const remainingPct = rawRemaining ?? (usedPct === null ? null : clampPct(100 - usedPct));
          return {
            id: cleanText(entry.id, 60) || `window-${index}`,
            label: cleanText(entry.label, 60) || `窗口 ${index + 1}`,
            shortLabel: cleanText(entry.shortLabel ?? "", 24),
            summary: entry.summary === true,
            usedPct,
            remainingPct,
            resetsAt: parseResetTime(entry.resetsAt),
            tone: normalizeTone(entry.tone, usedPct),
          };
        })
      : [];
  const balances: MenuUsageBalance[] =
    status === "available"
      ? (provider.balances ?? [])
          .flatMap((entry, index) => {
            const unit = normalizeUnit(entry.unit);
            if (!unit) return [];
            const used = finiteNumber(entry.used);
            const remaining = finiteNumber(entry.remaining);
            const limit = finiteNumber(entry.limit);
            if (used === null && remaining === null && limit === null) return [];
            return [
              {
                id: cleanText(entry.id, 60) || `balance-${index}`,
                label: cleanText(entry.label, 60) || "余额",
                used,
                remaining,
                limit,
                unit,
                resetsAt: parseResetTime(entry.resetsAt),
                tone: normalizeTone(entry.tone, null),
              },
            ];
          })
          .slice(0, 10)
      : [];
  const id = cleanText(provider.providerId, 40) || "provider";
  const name = cleanText(provider.displayName, 80) || id;
  const plan = provider.planLabel ? cleanText(provider.planLabel, 40) || null : null;
  return {
    id,
    name,
    status,
    plan,
    message: safeUsageAccountMessage(status, provider.error),
    windows,
    balances,
  };
}

export function usageFromProviderList(
  result: Pick<PaseoProviderUsageResult, "fetchedAt" | "providers">,
  now = Date.now(),
  limit = 20,
): MenuUsage {
  const parsedFetched = Date.parse(result.fetchedAt);
  const fetchedAt = Number.isFinite(parsedFetched) ? parsedFetched : now;
  const projected = (result.providers ?? []).map(usageAccountFromProvider);
  const rank: Record<UsageAccountStatus, number> = { available: 0, error: 1, unavailable: 2 };
  const sorted = projected
    .map((account, index) => ({ account, index }))
    .sort((a, b) => rank[a.account.status] - rank[b.account.status] || a.index - b.index)
    .map((entry) => entry.account);
  return {
    status: "ready",
    message: "",
    fetchedAt,
    accounts: sorted.slice(0, limit),
    omitted: Math.max(0, sorted.length - limit),
  };
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
  usage: MenuUsage = initialUsage(),
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
    usage,
  };
}
