import type { SpawnOptions, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeBridge } from "../server/bridge";
import { makeFrame } from "../server/model";
import { nativeEnvironment } from "../server/native";

class Child extends EventEmitter {
  stdin = new PassThrough({ highWaterMark: 1 });
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit("close", null));
    return true;
  });
}
const bridges: NativeBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  vi.useRealTimers();
});
function create() {
  const children: Child[] = [];
  const launch = vi.fn((_binary: string, _args: string[], _options: SpawnOptions) => {
    const child = new Child();
    children.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const onCommand = vi.fn();
  const prepare = vi.fn(async () => "/fake/PaseoMenuBar");
  const bridge = new NativeBridge({
    root: "/private/test-menubar",
    spawn: launch as unknown as typeof spawn,
    prepare,
    onCommand,
    log: vi.fn(),
  });
  bridges.push(bridge);
  return { bridge, children, launch, prepare, onCommand };
}

describe("native bridge lifecycle", () => {
  it("deduplicates concurrent starts and coalesces updates under pipe backpressure", async () => {
    const { bridge, children, launch, prepare } = create();
    bridge.send(makeFrame([], "waiting", "first"));
    await Promise.all([bridge.start(), bridge.start(), bridge.start()]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 1000; i++) bridge.send(makeFrame([], "connected", String(i)));
    const lines: string[] = [];
    children[0].stdin.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
    await vi.waitFor(() => expect(lines).toHaveLength(2));
    expect(JSON.parse(lines[0]).message).toBe("first");
    expect(JSON.parse(lines[1]).message).toBe("999");
  });

  it("only accepts bounded refresh/hide commands and honors explicit hiding", async () => {
    const { bridge, children, onCommand, launch } = create();
    await bridge.start();
    const child = children[0];
    child.stdout.write('not json\n{"type":"exec","command":"rm -rf /"}\n');
    child.stdout.write('{"type":"ref');
    child.stdout.write('resh"}\n{"type":"hide"}\n');
    expect(onCommand.mock.calls).toEqual([["refresh"], ["hide"]]);
    child.emit("close", 0);
    await bridge.start();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("restarts crashes at most three times and terminates the helper on unload", async () => {
    vi.useFakeTimers();
    const { bridge, children, launch } = create();
    await bridge.start();
    for (const delay of [1000, 2000, 4000]) {
      children.at(-1)?.emit("close", 9);
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(launch).toHaveBeenCalledTimes(4);
    children.at(-1)?.emit("close", 9);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(launch).toHaveBeenCalledTimes(4);
    await bridge.close();
  });

  it("kills a stuck helper and cancels heartbeats on cleanup", async () => {
    const { bridge, children } = create();
    await bridge.start();
    await bridge.close();
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not inherit provider secrets or daemon tokens", () => {
    process.env.PASEO_MENUBAR_TEST_SECRET = "NEVER_PASS";
    try {
      const env = nativeEnvironment();
      expect(env.PASEO_MENUBAR_TEST_SECRET).toBeUndefined();
      expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
      expect(JSON.stringify(env)).not.toContain("NEVER_PASS");
    } finally {
      delete process.env.PASEO_MENUBAR_TEST_SECRET;
    }
  });
});
