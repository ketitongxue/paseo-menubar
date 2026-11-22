import type { PaseoApi, PaseoProviderUsageResult } from "@getpaseo/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usageAccountFromProvider, usageFromProviderList } from "../server/model";
import { UsageObserver } from "../server/usage";
import { deferred } from "./helpers";

const observers: UsageObserver[] = [];

function createObserver(options?: ConstructorParameters<typeof UsageObserver>[1]) {
  const send = vi.fn();
  const observer = new UsageObserver(send, options);
  observers.push(observer);
  return { observer, send };
}

function fakeUsageApi(impl?: () => Promise<PaseoProviderUsageResult>): {
  api: PaseoApi;
  listUsage: ReturnType<typeof vi.fn>;
} {
  const listUsage = vi.fn(
    impl ??
      (async () => ({
        requestId: "usage-1",
        fetchedAt: "2026-11-22T09:00:00.000Z",
        providers: [
          {
            providerId: "codex",
            displayName: "Codex (user@example.com)",
            status: "available",
            planLabel: "plus",
            windows: [
              {
                id: "five_hour",
                label: "5-hour",
                shortLabel: "5h",
                summary: true,
                usedPct: 12.34,
                remainingPct: 87.66,
                resetsAt: "2026-11-22T14:00:00.000Z",
                tone: "ok",
              },
            ],
            balances: [],
            details: [],
            error: null,
          },
        ],
      })),
  );
  const api = {
    providers: { listUsage },
  } as unknown as PaseoApi;
  return { api, listUsage };
}

afterEach(() => {
  for (const observer of observers.splice(0)) observer.close();
  vi.useRealTimers();
});

describe("usage projection", () => {
  it("sanitizes text, clamps percentages, derives missing percentages, and drops epoch-0 reset timestamps", () => {
    const account = usageAccountFromProvider({
      providerId: "antigravity",
      displayName: "Antigravity\n\u202E\u0007",
      status: "available",
      planLabel: "pro\nplan",
      windows: [
        {
          id: "w1",
          label: "Gemini · Weekly",
          shortLabel: "Gemini wk",
          summary: true,
          usedPct: 11.3268,
          resetsAt: "1970-01-01T00:00:00Z",
        },
        {
          id: "w2",
          label: "Burst",
          remainingPct: 140,
          resetsAt: "2026-11-29T02:45:35Z",
        },
      ],
      balances: [
        {
          id: "credits",
          label: "Credits",
          remaining: 0,
          unit: "credits",
          tone: "danger",
        },
        {
          id: "empty",
          label: "Empty",
          unit: "usd",
        },
      ],
      details: [{ id: "secret", label: "Org", value: "SECRET_DETAIL" }],
      error: null,
    });
    expect(account).toMatchObject({
      id: "antigravity",
      name: "Antigravity",
      status: "available",
      plan: "pro plan",
      message: "",
    });
    expect(account.windows[0]).toMatchObject({
      usedPct: 11.3,
      remainingPct: 88.7,
      resetsAt: null,
      tone: "ok",
    });
    expect(account.windows[1]).toMatchObject({
      usedPct: 0,
      remainingPct: 100,
      tone: "ok",
    });
    expect(account.windows[1].resetsAt).toBe(Date.parse("2026-11-29T02:45:35Z"));
    expect(account.balances).toHaveLength(1);
    expect(account.balances[0]).toMatchObject({ label: "Credits", remaining: 0, unit: "credits" });
    expect(JSON.stringify(account)).not.toContain("SECRET_DETAIL");
  });

  it("classifies unavailable/error accounts safely without forwarding raw provider error bodies", () => {
    const rejected = usageAccountFromProvider({
      providerId: "cursor",
      displayName: "Cursor",
      status: "unavailable",
      planLabel: null,
      windows: [],
      error: "Login rejected (HTTP 401). Sign in again.",
    });
    expect(rejected.message).toBe("登录已失效，请在 Paseo 重新登录");

    const expired = usageAccountFromProvider({
      providerId: "codex",
      displayName: "Codex",
      status: "unavailable",
      planLabel: null,
      windows: [],
      error: "Login expired 2h ago. Run codex to refresh it.",
    });
    expect(expired.message).toBe("登录已过期，请在 Paseo 重新登录");

    const errored = usageAccountFromProvider({
      providerId: "custom",
      displayName: "Custom",
      status: "error",
      planLabel: null,
      windows: [],
      error: "SECRET_TOKEN_LEAK_IN_UPSTREAM_BODY",
    });
    expect(errored.message).toBe("额度查询失败，请在 Paseo 查看");
    expect(JSON.stringify(errored)).not.toContain("SECRET_TOKEN_LEAK");
  });

  it("sorts available accounts ahead of error/unavailable and caps the account list", () => {
    const providers = Array.from({ length: 25 }, (_, i) => ({
      providerId: `p-${i}`,
      displayName: `Provider ${i}`,
      status: (i === 0 ? "unavailable" : i === 1 ? "error" : "available") as
        | "available"
        | "unavailable"
        | "error",
      planLabel: null,
      windows: [],
      error: null,
    }));
    const usage = usageFromProviderList({
      fetchedAt: "2026-11-22T09:00:00.000Z",
      providers,
    });
    expect(usage.status).toBe("ready");
    expect(usage.accounts).toHaveLength(20);
    expect(usage.omitted).toBe(5);
    expect(usage.accounts[0].id).toBe("p-2");
    expect(usage.accounts.every((account) => account.status === "available")).toBe(true);
  });
});

describe("daemon-backed usage observation", () => {
  it("loads once on ensure, deduplicates concurrent calls, and polls every 5 minutes", async () => {
    vi.useFakeTimers();
    const { api, listUsage } = fakeUsageApi();
    const { observer } = createObserver();
    await Promise.all([observer.ensure(api), observer.ensure(api), observer.ensure(api)]);
    expect(listUsage).toHaveBeenCalledTimes(1);
    expect(observer.snapshot().status).toBe("ready");
    expect(observer.snapshot().accounts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(listUsage).toHaveBeenCalledTimes(2);

    observer.close();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(listUsage).toHaveBeenCalledTimes(2);
  });

  it("handles disabled usage and recovers on manual refresh when re-enabled", async () => {
    const { api, listUsage } = fakeUsageApi();
    listUsage.mockRejectedValueOnce(new Error("Usage is off on this host."));
    const { observer } = createObserver();
    await observer.ensure(api);
    expect(observer.snapshot()).toMatchObject({
      status: "disabled",
      message: "Paseo 主机未开启额度查询",
      accounts: [],
    });
    await observer.refresh();
    expect(observer.snapshot().status).toBe("ready");
    expect(observer.snapshot().accounts).toHaveLength(1);
  });

  it("marks unsupported hosts cleanly and stops background polling", async () => {
    vi.useFakeTimers();
    const { api, listUsage } = fakeUsageApi();
    listUsage.mockRejectedValue(new Error("Update the host to list provider usage."));
    const { observer } = createObserver();
    await observer.ensure(api);
    expect(observer.snapshot().status).toBe("unsupported");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(listUsage).toHaveBeenCalledTimes(1);
  });

  it("retains last known accounts on transient failure and times out hung calls", async () => {
    vi.useFakeTimers();
    const { api, listUsage } = fakeUsageApi();
    const { observer } = createObserver({ timeoutMs: 1_000 });
    await observer.ensure(api);
    expect(observer.snapshot().accounts).toHaveLength(1);

    const hung = deferred<PaseoProviderUsageResult>();
    listUsage.mockImplementationOnce(() => hung.promise);
    const pending = observer.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(observer.snapshot()).toMatchObject({
      status: "error",
      message: "额度刷新失败；以下为上次查询结果",
    });
    expect(observer.snapshot().accounts).toHaveLength(1);

    // Late resolution from timed-out call must not overwrite newer state after close.
    observer.close();
    hung.resolve({
      requestId: "late",
      fetchedAt: "2026-11-22T10:00:00.000Z",
      providers: [],
    });
    await Promise.resolve();
    expect(observer.snapshot().accounts).toHaveLength(1);
  });
});
