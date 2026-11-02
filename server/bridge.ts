import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import type { MenuFrame } from "../shared/state";
import { dataRoot, nativeEnvironment, prepareNative } from "./native";

interface Options {
  root?: string;
  prepare?: typeof prepareNative;
  spawn?: typeof spawn;
  log?: (message: string) => void;
  onCommand?: (command: "refresh" | "hide") => void;
}

/** Owns the helper, bounded JSON-lines transport, backpressure, and teardown. */
export class NativeBridge {
  private child?: ChildProcessWithoutNullStreams;
  private latest?: MenuFrame;
  private dirty = false;
  private blocked = false;
  private stopped = false;
  private hidden = false;
  private attempts = 0;
  private pending?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly lifetime = new AbortController();

  constructor(private readonly options: Options = {}) {}

  send(frame: MenuFrame) {
    this.latest = frame;
    this.dirty = true;
    this.flush();
  }

  private flush() {
    const stream = this.child?.stdin;
    if (!stream || stream.destroyed || !stream.writable || this.blocked || !this.dirty) return;
    this.dirty = false;
    this.blocked = !stream.write(`${JSON.stringify(this.latest)}\n`);
  }

  start(): Promise<void> {
    if (this.stopped || this.hidden || this.child) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.launch().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private log(message: string) {
    (this.options.log ?? console.error)(`Paseo Menu Bar: ${message}`);
  }

  private async launch() {
    const root = this.options.root ?? dataRoot();
    const binary = await (this.options.prepare ?? prepareNative)(root, this.lifetime.signal);
    if (this.stopped) return;
    const child = (this.options.spawn ?? spawn)(
      binary,
      ["--lock-file", join(root, "helper.lock")],
      {
        env: nativeEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.blocked = false;
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 4096) {
        output = "";
        child.kill();
        return;
      }
      let newline = output.indexOf("\n");
      while (newline >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        try {
          const command = JSON.parse(line);
          if (command?.type === "hide") this.hidden = true;
          if (command?.type === "refresh" || command?.type === "hide")
            this.options.onCommand?.(command.type);
        } catch {
          // Ignore invalid commands; never execute shell strings or arbitrary URLs.
        }
        newline = output.indexOf("\n");
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {
      // EPIPE while a user hides the UI or the helper exits is normal.
    });
    child.stdin.on("drain", () => {
      this.blocked = false;
      this.flush();
    });
    child.once("close", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      clearInterval(this.heartbeat);
      if (code === 73) {
        this.hidden = true;
        this.log("同一 daemon 已有菜单栏实例，请勿重复安装。");
      }
      if (this.stopped || this.hidden || code === 0) return;
      if (++this.attempts > 3) {
        this.log("原生组件连续退出；请检查本机图形登录会话后重载插件。");
        return;
      }
      this.retry = setTimeout(
        () => void this.start().catch(() => this.log("原生组件重启失败。")),
        1000 * 2 ** (this.attempts - 1),
      );
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    this.dirty = this.latest !== undefined;
    this.flush();
    this.heartbeat = setInterval(() => {
      this.dirty = this.latest !== undefined;
      this.flush();
    }, 10_000);
    this.heartbeat.unref();
  }

  async close() {
    this.stopped = true;
    this.lifetime.abort();
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    await this.pending?.catch(() => {});
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
      child.once("close", () => {
        clearTimeout(kill);
        resolve();
      });
      child.stdin.end();
      child.kill("SIGTERM");
    });
    this.child = undefined;
  }
}
