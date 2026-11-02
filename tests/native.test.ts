import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFrame, taskFromAgent } from "../server/model";
import { prepareNative } from "../server/native";
import { nativeSource } from "../server/native-source";
import { agent } from "./helpers";

it("bundles exactly the reviewed Swift source", async () => {
  expect(nativeSource).toBe(await readFile("native/main.swift", "utf8"));
});

describe.skipIf(process.platform !== "darwin")(
  "real Swift binary, headless protocol checks",
  () => {
    let root: string;
    let binary: string;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "paseo-menubar-native-"));
      binary = await prepareNative(root);
    }, 150_000);
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });

    function check(input: unknown): Promise<{ code: number | null; output: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(binary, ["--check"], { stdio: ["pipe", "pipe", "ignore"] });
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, output }));
        child.stdin.end(`${JSON.stringify(input)}\n`);
      });
    }

    it("renders running/permission/completed badges using the actual Swift presentation code", async () => {
      for (const [overrides, title] of [
        [{ status: "running" }, "P 1"],
        [{ requiresAttention: true, attentionReason: "permission" }, "P !1"],
        [{ requiresAttention: true, attentionReason: "finished" }, "P ✓1"],
        [{ status: "idle" }, "P 空闲"],
      ] as const) {
        const task = taskFromAgent(agent(overrides));
        const result = await check(makeFrame(task ? [task] : [], "connected"));
        expect(result.code).toBe(0);
        expect(JSON.parse(result.output).title).toBe(title);
      }
    });

    it("processes small live frames immediately without waiting for a full pipe buffer or EOF", async () => {
      const child = spawn(binary, ["--check-live"], { stdio: ["pipe", "pipe", "ignore"] });
      const reader = createInterface({ input: child.stdout });
      try {
        for (const connection of ["connected", "error", "connected"] as const) {
          const frame = `${JSON.stringify(makeFrame([], connection))}\n`;
          const response = once(reader, "line", { signal: AbortSignal.timeout(2000) });
          child.stdin.write(frame.slice(0, 10));
          child.stdin.write(frame.slice(10));
          const [line] = await response;
          expect(JSON.parse(line).title).toBe(connection === "error" ? "P 离线" : "P 空闲");
          expect(child.stdin.writable).toBe(true);
          expect(child.exitCode).toBeNull();
        }
        const closed = once(child, "close");
        child.stdin.end();
        expect((await closed)[0]).toBe(0);
      } finally {
        reader.close();
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    });

    it("shows offline rather than disguising stale data as a current successful state", async () => {
      const result = await check(makeFrame([], "error", "同步失败"));
      expect(JSON.parse(result.output)).toMatchObject({ title: "P 离线", detail: "同步失败" });
    });

    it("rejects unknown protocol versions and out-of-range counts", async () => {
      const frame = makeFrame([], "connected");
      expect((await check({ ...frame, version: 99 })).code).toBe(1);
      expect((await check({ ...frame, counts: { ...frame.counts, running: -1 } })).code).toBe(1);
    });

    it("reuses an immutable executable cache and keeps the data root private", async () => {
      const before = await stat(binary);
      expect(await prepareNative(root)).toBe(binary);
      expect((await stat(binary)).mtimeMs).toBe(before.mtimeMs);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    });
  },
);
