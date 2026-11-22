import type { MenuUsage } from "../shared/state";
import { initialUsage, usageFromProviderList } from "./model";
import type { PaseoApi } from "./paseo";

const DEFAULT_POLL_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 25_000;

interface Options {
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** Daemon-backed quota observer. Reads Paseo's unified usage API without touching credentials. */
export class UsageObserver {
  private api?: PaseoApi;
  private state: MenuUsage = initialUsage();
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private activeTimeout?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private generation = 0;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly send: (usage: MenuUsage) => void,
    options: Options = {},
  ) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  snapshot(): MenuUsage {
    return this.state;
  }

  ensure(api: PaseoApi): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.api) {
      this.api = api;
      this.timer = setInterval(() => void this.refresh().catch(() => {}), this.pollMs);
      this.timer.unref();
    }
    return this.state.status === "idle" || this.state.status === "error"
      ? this.refresh()
      : Promise.resolve();
  }

  refresh(): Promise<void> {
    if (this.stopped || !this.api) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private emit(next: MenuUsage) {
    if (this.stopped) return;
    this.state = next;
    this.send(next);
  }

  private async load() {
    const api = this.api;
    if (this.stopped || !api) return;
    const generation = ++this.generation;
    if (typeof api.providers?.listUsage !== "function") {
      clearInterval(this.timer);
      this.timer = undefined;
      this.emit({
        status: "unsupported",
        message: "当前 Paseo 主机不支持额度查询",
        fetchedAt: null,
        accounts: [],
        omitted: 0,
      });
      return;
    }
    if (this.state.accounts.length === 0 && this.state.status !== "loading") {
      this.emit({ ...this.state, status: "loading", message: "正在查询账号额度…" });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = api.providers.listUsage();
      // Suppress late unhandled rejections if timeout or close settles first.
      request.catch(() => {});
      const result = await new Promise<Awaited<typeof request>>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Usage query timed out")), this.timeoutMs);
        this.activeTimeout = timer;
        request.then(resolve, reject);
      });
      if (this.stopped || generation !== this.generation) return;
      this.emit(usageFromProviderList(result, this.now()));
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      const reason = error instanceof Error ? error.message : "";
      if (/usage is off on this host/i.test(reason)) {
        this.emit({
          status: "disabled",
          message: "Paseo 主机未开启额度查询",
          fetchedAt: null,
          accounts: [],
          omitted: 0,
        });
        return;
      }
      if (/update the host to list provider usage/i.test(reason)) {
        clearInterval(this.timer);
        this.timer = undefined;
        this.emit({
          status: "unsupported",
          message: "当前 Paseo 主机不支持额度查询",
          fetchedAt: null,
          accounts: [],
          omitted: 0,
        });
        return;
      }
      this.emit({
        ...this.state,
        status: "error",
        message:
          this.state.accounts.length > 0
            ? "额度刷新失败；以下为上次查询结果"
            : "额度查询失败，请稍后重试",
      });
    } finally {
      clearTimeout(timer);
      if (this.activeTimeout === timer) this.activeTimeout = undefined;
    }
  }

  close() {
    this.stopped = true;
    this.generation++;
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.activeTimeout);
    this.activeTimeout = undefined;
  }
}
