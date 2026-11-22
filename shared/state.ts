export const taskStatuses = [
  "permission",
  "error",
  "running",
  "initializing",
  "done",
  "idle",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const usageStatuses = [
  "idle",
  "loading",
  "ready",
  "disabled",
  "unsupported",
  "error",
] as const;
export type UsageStatus = (typeof usageStatuses)[number];

export const usageAccountStatuses = ["available", "unavailable", "error"] as const;
export type UsageAccountStatus = (typeof usageAccountStatuses)[number];

export const usageTones = ["default", "ok", "warning", "danger"] as const;
export type UsageTone = (typeof usageTones)[number];

export const usageBalanceUnits = ["usd", "credits", "requests", "tokens"] as const;
export type UsageBalanceUnit = (typeof usageBalanceUnits)[number];

export interface MenuTask {
  id: string;
  title: string;
  provider: string;
  project: string;
  status: TaskStatus;
  updatedAt: number;
  startedAt: number | null;
  url: string | null;
}

export interface MenuUsageWindow {
  id: string;
  label: string;
  shortLabel: string;
  summary: boolean;
  usedPct: number | null;
  remainingPct: number | null;
  resetsAt: number | null;
  tone: UsageTone;
}

export interface MenuUsageBalance {
  id: string;
  label: string;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  unit: UsageBalanceUnit;
  resetsAt: number | null;
  tone: UsageTone;
}

export interface MenuUsageAccount {
  id: string;
  name: string;
  status: UsageAccountStatus;
  plan: string | null;
  message: string;
  windows: MenuUsageWindow[];
  balances: MenuUsageBalance[];
}

export interface MenuUsage {
  status: UsageStatus;
  message: string;
  fetchedAt: number | null;
  accounts: MenuUsageAccount[];
  omitted: number;
}

export interface MenuFrame {
  version: 1;
  connection: "waiting" | "connected" | "error";
  message: string;
  updatedAt: number;
  counts: Record<TaskStatus, number>;
  tasks: MenuTask[];
  omitted: number;
  usage: MenuUsage;
}
