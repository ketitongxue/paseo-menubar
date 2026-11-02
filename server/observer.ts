import type { MenuFrame, MenuTask } from "../shared/state";
import { makeFrame, taskFromAgent } from "./model";
import type {
  AgentSubscription,
  PaseoAgent,
  PaseoAgentListOptions,
  PaseoAgentListResult,
  PaseoApi,
} from "./paseo";

const query: PaseoAgentListOptions = {
  filter: { includeArchived: false, statuses: ["initializing", "idle", "running", "error"] },
  sort: [{ key: "updated_at", direction: "desc" }],
};

/** One daemon-owned observation. No provider opens, timeline reads, or agent mutations. */
export class TaskObserver {
  private api?: PaseoApi;
  private tasks = new Map<string, MenuTask>();
  private connection: MenuFrame["connection"] = "waiting";
  private message = "打开 Paseo 客户端，或等待下一次任务事件以连接";
  private subscription?: AgentSubscription;
  private unsubscribe?: () => void;
  private lifetime?: AbortController;
  private pages?: AbortController;
  private pending?: Promise<void>;
  private stopped = false;
  private generation = 0;
  private lastSyncedAt = Date.now();
  private timer?: ReturnType<typeof setInterval>;
  private publishTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly send: (frame: MenuFrame) => void) {}

  snapshot(): MenuFrame {
    return makeFrame(this.tasks.values(), this.connection, this.message, this.lastSyncedAt);
  }

  ensure(api: PaseoApi): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.api) {
      this.api = api;
      this.timer = setInterval(() => void this.refresh().catch(() => {}), 30_000);
      this.timer.unref();
    }
    return this.subscription && this.connection === "connected"
      ? Promise.resolve()
      : this.refresh();
  }

  refresh(): Promise<void> {
    if (this.stopped || !this.api) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.observe().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private publish(throttle = false) {
    if (this.stopped) return;
    if (throttle) {
      // A trailing debounce would starve the UI during a continuous update stream.
      this.publishTimer ??= setTimeout(() => {
        this.publishTimer = undefined;
        this.publish();
      }, 100);
    } else {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
      this.send(this.snapshot());
    }
  }

  private failed() {
    this.connection = "error";
    this.message = "与 Paseo 同步失败；当前列表可能已过期，将自动重试";
    this.publish();
  }

  private project(agent: PaseoAgent): MenuTask | null {
    return taskFromAgent(agent, this.api?.agents.ref(agent.id).address.serverId);
  }

  private async observe() {
    const previous = this.subscription;
    this.subscription = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.lifetime?.abort();
    this.pages?.abort();
    this.generation++;
    await previous?.release().catch(() => {});
    if (this.stopped || !this.api) return;
    const api = this.api;
    const lifetime = new AbortController();
    this.lifetime = lifetime;
    const timeout = setTimeout(() => lifetime.abort(), 15_000);
    try {
      const { subscription } = await api.agents.list({
        ...query,
        page: { limit: 200 },
        subscribe: {},
        signal: lifetime.signal,
      });
      if (this.stopped || lifetime.signal.aborted) {
        await subscription.release().catch(() => {});
        if (!this.stopped) throw new Error("Observation aborted");
        return;
      }
      this.subscription = subscription;
      let loading = false;
      let queued = new Map<string, MenuTask | null>();
      let initialLoad: Promise<void> | undefined;
      this.unsubscribe = subscription.subscribe({
        snapshot: (snapshot) => {
          const generation = ++this.generation;
          this.pages?.abort();
          const pages = new AbortController();
          this.pages = pages;
          loading = true;
          queued = new Map();
          const updates = queued;
          const load = async () => {
            const next = new Map<string, MenuTask>();
            const signal = AbortSignal.any([lifetime.signal, pages.signal]);
            const pageTimeout = setTimeout(() => pages.abort(), 15_000);
            try {
              const add = (page: PaseoAgentListResult) => {
                for (const { agent } of page.entries) {
                  const task = this.project(agent);
                  if (task) next.set(agent.id, task);
                }
              };
              add(snapshot);
              let page: PaseoAgentListResult = snapshot;
              const cursors = new Set<string>();
              while (page.pageInfo.hasMore) {
                const cursor = page.pageInfo.nextCursor;
                if (!cursor || cursors.has(cursor) || cursors.size >= 1_000)
                  throw new Error("Invalid directory pagination");
                cursors.add(cursor);
                page = await api.agents.list({ ...query, page: { limit: 200, cursor }, signal });
                if (generation !== this.generation || this.stopped) return;
                if (signal.aborted) throw new Error("Directory snapshot timed out");
                add(page);
              }
              if (generation !== this.generation || this.stopped) return;
              if (signal.aborted) throw new Error("Directory snapshot timed out");
              // Live updates/removals received during paging always win over snapshot rows.
              for (const [id, task] of updates) {
                if (task) next.set(id, task);
                else next.delete(id);
              }
              loading = false;
              this.tasks = next;
              this.connection = "connected";
              this.message = "";
              this.lastSyncedAt = Date.now();
              this.publish();
            } catch (error) {
              // A reconnect supersedes and aborts the previous pager. Its rejection
              // must not turn a newer healthy snapshot into an offline state.
              if (generation !== this.generation || this.stopped) return;
              throw error;
            } finally {
              clearTimeout(pageTimeout);
            }
          };
          initialLoad = load();
          void initialLoad.catch(() => {
            if (!this.stopped && generation === this.generation) this.failed();
          });
        },
        update: (message) => {
          if (this.stopped || lifetime.signal.aborted || message.type !== "agent_update") return;
          const update = message.payload;
          const id = update.kind === "remove" ? update.agentId : update.agent.id;
          const task = update.kind === "remove" ? null : this.project(update.agent);
          if (loading) queued.set(id, task);
          else {
            if (task) this.tasks.set(id, task);
            else this.tasks.delete(id);
            this.lastSyncedAt = Date.now();
            this.publish(true);
          }
        },
        error: () => {
          if (!this.stopped && !lifetime.signal.aborted) this.failed();
        },
      });
      await initialLoad;
    } catch {
      if (!this.stopped) {
        this.failed();
        throw new Error("Paseo 菜单栏同步失败；将在后台重试。");
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async close() {
    this.stopped = true;
    this.generation++;
    clearInterval(this.timer);
    clearTimeout(this.publishTimer);
    this.pages?.abort();
    this.lifetime?.abort();
    this.unsubscribe?.();
    await this.subscription?.release().catch(() => {});
    this.subscription = undefined;
  }
}
