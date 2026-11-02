import type { PaseoAgentListResult } from "@getpaseo/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskObserver } from "../server/observer";
import { agent, deferred, fakeApi, page, Subscription } from "./helpers";

const observers: TaskObserver[] = [];
function create() {
  const send = vi.fn();
  const observer = new TaskObserver(send);
  observers.push(observer);
  return { observer, send };
}
afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.close()));
  vi.useRealTimers();
});

describe("daemon-owned real-time observation", () => {
  it("opens exactly one subscription for concurrent bootstraps and handles live updates", async () => {
    vi.useFakeTimers();
    const { api, list, sub } = fakeApi(new Subscription(page([agent()])));
    const { observer, send } = create();
    await Promise.all([observer.ensure(api), observer.ensure(api), observer.ensure(api)]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]).toMatchObject([
      { subscribe: {}, page: { limit: 200 }, filter: { includeArchived: false } },
    ]);
    sub.upsert(agent({ status: "running" }));
    await vi.advanceTimersByTimeAsync(100);
    expect(send.mock.lastCall?.[0].counts.running).toBe(1);
    sub.remove("agent-1");
    await vi.advanceTimersByTimeAsync(100);
    expect(observer.snapshot().tasks).toHaveLength(0);
    await observer.ensure(api);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not starve the menu during a continuous update stream", async () => {
    vi.useFakeTimers();
    const { api, sub } = fakeApi(new Subscription(page([agent()])));
    const { observer, send } = create();
    await observer.ensure(api);
    send.mockClear();
    for (let i = 0; i < 50; i++) {
      sub.upsert(agent({ status: "running", title: String(i) }));
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(send.mock.lastCall?.[0].tasks[0].title).toBe("49");
  });

  it("paginates beyond 200 and live removals/newer states win over stale pages", async () => {
    const sub = new Subscription(page([agent({ id: "first" })], "page-2"));
    const { api, list } = fakeApi(sub);
    const tail = deferred<PaseoAgentListResult>();
    list.mockImplementationOnce(async () => ({
      ...sub.initial,
      subscription: sub,
      subscriptionId: sub.subscriptionId,
    }));
    list.mockImplementationOnce(() => tail.promise as ReturnType<typeof list>);
    const { observer } = create();
    const ready = observer.ensure(api);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    sub.remove("first");
    sub.upsert(agent({ id: "last", status: "running" }));
    tail.resolve(page([agent({ id: "first" }), agent({ id: "last", status: "idle" })]));
    await ready;
    expect(observer.snapshot().tasks.map((task) => task.id)).toEqual(["last"]);
    expect(observer.snapshot().counts.running).toBe(1);
    expect(observer.snapshot().connection).toBe("connected");
    expect(observer.snapshot().tasks[0].url).toContain("server%20%2F%20%E4%B8%AD%E6%96%87");
  });

  it("replaces snapshots on reconnect, instead of retaining deleted agents", async () => {
    const { api, sub } = fakeApi(new Subscription(page([agent()])));
    const { observer } = create();
    await observer.ensure(api);
    sub.snapshot(page([agent({ id: "replacement", status: "error" })]));
    await vi.waitFor(() => expect(observer.snapshot().tasks[0]?.id).toBe("replacement"));
    expect(observer.snapshot().tasks).toHaveLength(1);
  });

  it("ignores an older paginated snapshot when a reconnect snapshot supersedes it", async () => {
    const sub = new Subscription(page([agent()], "tail"));
    const { api, list } = fakeApi(sub);
    const tail = deferred<PaseoAgentListResult>();
    list.mockImplementationOnce(async () => ({
      ...sub.initial,
      subscription: sub,
      subscriptionId: sub.subscriptionId,
    }));
    list.mockImplementationOnce(() => tail.promise as ReturnType<typeof list>);
    const { observer } = create();
    const ready = observer.ensure(api);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    sub.snapshot(page([agent({ id: "new" })]));
    tail.resolve(page([agent({ id: "old" })]));
    await ready;
    expect(observer.snapshot().tasks.map((task) => task.id)).toEqual(["new"]);
  });

  it("does not let an aborted old pager mark a newer reconnect snapshot offline", async () => {
    const sub = new Subscription(page([agent()], "tail"));
    const { api, list } = fakeApi(sub);
    const tail = deferred<PaseoAgentListResult>();
    list.mockImplementationOnce(async () => ({
      ...sub.initial,
      subscription: sub,
      subscriptionId: sub.subscriptionId,
    }));
    list.mockImplementationOnce(() => tail.promise as ReturnType<typeof list>);
    const { observer } = create();
    const ready = observer.ensure(api);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    sub.snapshot(page([agent({ id: "new" })]));
    tail.reject(new Error("Aborted superseded request"));
    await ready;
    expect(observer.snapshot().connection).toBe("connected");
    expect(observer.snapshot().tasks[0].id).toBe("new");
  });

  it("marks failures stale, retains last known state, and recovers on refresh", async () => {
    const { api, sub, list } = fakeApi(new Subscription(page([agent({ status: "running" })])));
    const { observer } = create();
    await observer.ensure(api);
    list.mockRejectedValueOnce(new Error("SENSITIVE_BACKEND_ERROR"));
    await expect(observer.refresh()).rejects.toThrow("同步失败");
    expect(observer.snapshot()).toMatchObject({ connection: "error", counts: { running: 1 } });
    expect(JSON.stringify(observer.snapshot())).not.toContain("SENSITIVE");
    sub.initial = page();
    await observer.refresh();
    expect(observer.snapshot()).toMatchObject({ connection: "connected", tasks: [] });
    expect(sub.release).toHaveBeenCalled();
  });

  it("reconciles every 30 seconds and releases its previous subscription", async () => {
    vi.useFakeTimers();
    const { api, sub, list } = fakeApi();
    const { observer } = create();
    await observer.ensure(api);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(sub.release).toHaveBeenCalledTimes(1);
    await observer.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not attach a late subscription or publish after teardown", async () => {
    const { api, sub, list } = fakeApi();
    const late = deferred<Awaited<ReturnType<typeof list>>>();
    list.mockImplementationOnce(() => late.promise);
    const { observer, send } = create();
    const ready = observer.ensure(api);
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    await observer.close();
    late.resolve({ ...page(), subscription: sub, subscriptionId: sub.subscriptionId });
    await ready;
    expect(sub.release).toHaveBeenCalledTimes(1);
    expect(sub.observer).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a broken pagination cursor rather than reporting partial success", async () => {
    const sub = new Subscription(page([agent()], "same"));
    const { api } = fakeApi(sub);
    const { observer } = create();
    await expect(observer.ensure(api)).rejects.toThrow("同步失败");
    expect(observer.snapshot().connection).toBe("error");
  });
});
