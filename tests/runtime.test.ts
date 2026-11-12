import { fork } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { compileDirectoryPlugin as BaselineCompiler } from "../node_modules/@getpaseo/server/dist/server/server/plugins/compiler-build.js";
import type { PluginRuntime as BaselineRuntime } from "../node_modules/@getpaseo/server/dist/server/server/plugins/runtime.js";
import { hostPackage, paseoTargets, serverDirectory } from "../scripts/paseo-targets";
import type { MenuFrame } from "../shared/state";
import { agent, page } from "./helpers";

const hosts = await Promise.all(
  paseoTargets.map(async (target) => {
    const directory = serverDirectory(target);
    const { version } = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const compiler = await import(
      pathToFileURL(join(directory, "dist/server/server/plugins/compiler-build.js")).href
    );
    const runtime = await import(
      pathToFileURL(join(directory, "dist/server/server/plugins/runtime.js")).href
    );
    const requireHost = createRequire(join(directory, "package.json"));
    const protocol = await import(
      pathToFileURL(requireHost.resolve("@getpaseo/protocol/messages")).href
    );
    const lifecycle = await import(
      pathToFileURL(join(hostPackage(target, "@getpaseo/plugin"), "dist/server/lifecycle.js")).href
    );
    const background = protocol.AgentSnapshotPayloadSchema.parse({
      ...agent(),
      id: "background-helper",
      background: true,
    });
    return {
      version: version as string,
      createHook: lifecycle.pluginHookRegistry?.["agent.create.after"]
        ? "agent.create.after"
        : "agent.created",
      backgroundAgent: background.background === true ? background : undefined,
      directory,
      compile: compiler.compileDirectoryPlugin as typeof BaselineCompiler,
      Runtime: runtime.PluginRuntime as typeof BaselineRuntime,
    };
  }),
);

const files = [
  "index.server.ts",
  "index.client.tsx",
  "paseo-plugin.json",
  "assets",
  "server",
  "client",
  "shared",
];

describe.each(hosts)(
  "Paseo $version real compiler and IPC",
  ({ compile, Runtime, directory, version, createHook, backgroundAgent }) => {
    it("compiles both actual entries and enforces the supported version range", async () => {
      const result = await compile(process.cwd(), version);
      expect(result.serverBundle?.length).toBeGreaterThan(1000);
      expect(result.clientBundle?.length).toBeGreaterThan(100);
      await expect(compile(process.cwd(), "0.13.2")).rejects.toThrow();
      await expect(compile(process.cwd(), "0.17.0-beta.1")).rejects.toThrow();
    });

    it("compiles an isolated installation without any node_modules", async () => {
      const root = await mkdtemp(join(tmpdir(), "paseo-menubar-production-"));
      try {
        for (const file of files) await cp(resolve(file), join(root, file), { recursive: true });
        const result = await compile(root, version);
        expect(result.serverBundle?.length).toBeGreaterThan(1000);
        expect(result.clientBundle?.length).toBeGreaterThan(100);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform !== "darwin")(
      "loads the actual entry, reads live SDK snapshots, and tears down the helper",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "paseo-menubar-ipc-"));
        const stateFile = join(root, "native-frame.json");
        const helper = join(root, "helper.cjs");
        const helperPid = join(root, "helper.pid");
        const subId = "menubar-test-subscription";
        let send: (message: unknown) => void = () => {};
        let released = false;
        const requests: string[] = [];
        for (const file of files) await cp(resolve(file), join(root, file), { recursive: true });
        // Only the OS boundary is substituted: the entry, monitor, bridge, host SDK,
        // compiler and plugin subprocess are real. Native Swift is tested separately.
        await writeFile(
          helper,
          `#!${process.execPath}\nconst fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(helperPid)}, String(process.pid), {mode:0o600});
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => fs.writeFileSync(${JSON.stringify(stateFile)}, line, {mode:0o600}));
rl.on('close', () => process.exit(0));\n`,
          { mode: 0o700 },
        );
        await writeFile(
          join(root, "server/native.ts"),
          `export const dataRoot = () => ${JSON.stringify(root)};
export const nativeEnvironment = () => ({ PATH: '/usr/bin:/bin' });
export const prepareNative = async () => ${JSON.stringify(helper)};\n`,
        );
        const runtime = new Runtime(pino({ level: "silent" }), version, {
          spawnChild: () =>
            fork(join(directory, "dist/server/server/plugins/plugin-process.js"), [], {
              execArgv: [],
              serialization: "advanced",
              stdio: ["ignore", "pipe", "pipe", "ipc"],
              env: { PATH: process.env.PATH, HOME: root, PASEO_HOME: root },
            }),
          sessionHost: {
            async attachPluginSocket(_id, socket) {
              const closed = new Promise<void>((done) => socket.once("close", () => done()));
              send = (message) => socket.send(JSON.stringify({ type: "session", message }));
              socket.on("message", (data) => {
                if (typeof data !== "string") return;
                const frame = JSON.parse(data);
                if (frame.type === "hello")
                  send({
                    type: "status",
                    payload: {
                      status: "server_info",
                      serverId: "synthetic-host",
                      hostname: "test",
                      version,
                      features: { ownedSubscriptions: true },
                    },
                  });
                const message = frame.message;
                if (!message) return;
                requests.push(message.type);
                if (message.type === "fetch_agents_request")
                  send({
                    type: "fetch_agents_response",
                    payload: {
                      ...page([agent({ status: "running" })]),
                      requestId: message.requestId,
                      subscriptionId: subId,
                    },
                  });
                if (message.type === "subscription.release.request") {
                  released = true;
                  send({
                    type: "subscription.release.response",
                    payload: {
                      requestId: message.requestId,
                      subscriptionId: message.subscriptionId,
                    },
                  });
                }
              });
              return { closed };
            },
          },
        });
        const snapshot = async () => JSON.parse(await readFile(stateFile, "utf8")) as MenuFrame;
        try {
          await runtime.startPlugin("paseo-menubar", root);
          // Exercise notification bootstrap with no client RPC first. The actual
          // host maps this plugin's legacy registration to its modern event name.
          const notify = runtime.emit.bind(runtime) as (name: string, event: unknown) => void;
          notify(createHook, {
            agent: {
              id: "agent-1",
              workspaceId: null,
              parentAgentId: null,
              provider: "codex",
              cwd: "/example/project",
              title: "Synthetic task",
              background: false,
              metadata: {},
            },
          });
          await runtime.drainEvents();
          await vi.waitFor(async () => expect((await snapshot()).counts.running).toBe(1));
          expect(await runtime.invoke("paseo-menubar", "menubar.start", {})).toEqual({
            supported: true,
          });
          expect(requests.filter((type) => type === "fetch_agents_request")).toHaveLength(1);
          if (backgroundAgent)
            send({
              type: "agent_update",
              payload: { kind: "upsert", subscriptionId: subId, agent: backgroundAgent },
            });
          send({
            type: "agent_update",
            payload: {
              kind: "upsert",
              subscriptionId: subId,
              agent: agent({ status: "error", lastError: "SECRET_ERROR_BODY" }),
            },
          });
          await vi.waitFor(async () => expect((await snapshot()).counts.error).toBe(1));
          expect(JSON.stringify(await snapshot())).not.toContain("SECRET_ERROR_BODY");
          expect((await snapshot()).tasks).toHaveLength(1);
          expect((await snapshot()).tasks[0].url).toBe("paseo://h/synthetic-host/agent/agent-1");
          send({
            type: "agent_update",
            payload: { kind: "remove", subscriptionId: subId, agentId: "agent-1" },
          });
          await vi.waitFor(async () => expect((await snapshot()).tasks).toHaveLength(0));
          await runtime.stopPluginById("paseo-menubar");
          expect(released).toBe(true);
          const pid = Number(await readFile(helperPid, "utf8"));
          expect(() => process.kill(pid, 0)).toThrow();
          expect(
            requests.every((type) =>
              ["fetch_agents_request", "subscription.release.request"].includes(type),
            ),
          ).toBe(true);
        } finally {
          await runtime.stopAll();
          await rm(root, { recursive: true, force: true });
        }
      },
      30_000,
    );
  },
);
