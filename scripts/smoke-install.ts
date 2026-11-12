import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pino from "pino";
import { paseoTargets, serverDirectory } from "./paseo-targets";

// Explicit developer action. Never selects or restarts the production daemon.
const revision = process.argv[2];
if (process.platform !== "darwin" || !/^[a-f0-9]{40}$/.test(revision ?? ""))
  throw new Error("Provide an exact public release commit on a graphical Mac.");
const command =
  process.env.PASEO_TEST_CLI || "/Applications/Paseo.app/Contents/Resources/bin/paseo";
const expectedVersion = process.argv[3] ?? "0.16.0-beta.2";
const target = paseoTargets.find((item) => item.version === expectedVersion);
if (!target) throw new Error("Expected version must name an explicitly tested Paseo runtime.");
const requireHost = createRequire(join(serverDirectory(target), "package.json"));
const { createHostClient } = (await import(
  pathToFileURL(requireHost.resolve("@getpaseo/client/node")).href
)) as typeof import("@getpaseo/client/node");
const { readLocalCredentialForTarget } = (await import(
  `${target.package}/daemon-control`
)) as typeof import("paseo-server-016-beta2/daemon-control");
const source = "https://github.com/ketitongxue/paseo-menubar.git";
const root = await realpath(await mkdtemp(join(tmpdir(), "paseo-menubar-install-")));
const user = join(root, "user");
const home = join(user, ".paseo");
const env = {
  PATH: process.env.PATH,
  HOME: user,
  USERPROFILE: user,
  XDG_CONFIG_HOME: join(user, ".config"),
  XDG_DATA_HOME: join(user, ".local/share"),
  XDG_CACHE_HOME: join(user, ".cache"),
  XDG_STATE_HOME: join(user, ".local/state"),
  TMPDIR: root,
  TMP: root,
  TEMP: root,
  LANG: "en_US.UTF-8",
  PASEO_HOME: home,
  CODEX_HOME: join(user, ".codex"),
};
const exec = promisify(execFile);
async function run(args: string[], timeout = 20_000) {
  const result = await exec(command, [...args, "--home", home, "--json"], {
    env,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}
let child: ReturnType<typeof spawn> | undefined;
let closed: Promise<unknown> | undefined;
let diagnostic = "";
try {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      version: 1,
      daemon: { listen: "127.0.0.1:0", relay: { enabled: false }, mcp: { enabled: false } },
      agents: {
        providers: Object.fromEntries(
          ["claude", "codex", "copilot", "cursor", "opencode", "pi", "omp"].map((id) => [
            id,
            { enabled: false },
          ]),
        ),
      },
      pluginsEnabled: true,
    }),
    { mode: 0o600 },
  );
  child = spawn(command, ["daemon", "run", "--home", home], {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer | Error) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-16_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", append);
  closed = new Promise((done) => child?.once("close", done));
  let ready: { daemonVersion: string; home: string } | undefined;
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error("Temporary daemon exited before readiness.");
    try {
      const status = await run(["daemon", "status"], 5000);
      if (status.connectedDaemon === "reachable") {
        ready = status;
        break;
      }
    } catch {
      // Wait only for the explicitly selected temporary home.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  if (!ready || ready.daemonVersion !== expectedVersion || ready.home !== home)
    throw new Error("Could not reach the expected isolated daemon.");
  await run(["plugin", "install", source, "--ref", revision], 120_000);
  const plugins = await run(["plugin", "ls"]);
  const installed = plugins.find((plugin: { id: string }) => plugin.id === "paseo-menubar");
  if (installed?.status !== "running" || installed.error)
    throw new Error("Public Git installation did not become running.");
  const { listen } = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8"));
  const client = createHostClient(listen, {
    clientId: "menubar-isolated-install-check",
    clientType: "cli",
    appVersion: expectedVersion,
    localCredential: () => readLocalCredentialForTarget(home, listen) ?? undefined,
    logger: pino({ level: "silent" }),
    reconnect: { enabled: false },
    connectTimeoutMs: 15_000,
  });
  try {
    await client.connect();
    const result = await client.invokePluginRpc("paseo-menubar", "menubar.start", {});
    if (!(result as { supported?: boolean }).supported)
      throw new Error("Native observation did not initialize.");
  } finally {
    await client.close();
  }
  await new Promise((done) => setTimeout(done, 500));
  const lock = join(home, "menubar/helper.lock");
  const helperPid = Number((await exec("/usr/sbin/lsof", ["-t", lock])).stdout.trim());
  if (!Number.isSafeInteger(helperPid) || helperPid <= 0)
    throw new Error("Expected exactly one live native helper.");
  process.kill(helperPid, 0);
  await run(["daemon", "stop"]);
  await Promise.race([
    closed,
    new Promise((_, fail) =>
      setTimeout(() => fail(new Error("Isolated daemon did not stop.")), 10_000),
    ),
  ]);
  let alive = true;
  try {
    process.kill(helperPid, 0);
  } catch {
    alive = false;
  }
  if (alive) throw new Error("Native helper survived isolated daemon shutdown.");
  const result = {
    source,
    commit: revision,
    daemonVersion: expectedVersion,
    clientVersion: expectedVersion,
    installation: "running",
    observationInitialized: true,
    nativeHelperRunning: true,
    nativeHelperStoppedOnShutdown: true,
    temporaryHome: true,
    modelTurns: 0,
    productionDaemonTouched: false,
  };
  await mkdir(".research", { recursive: true });
  await writeFile(
    `.research/public-install-result-${expectedVersion}.json`,
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
} catch (error) {
  await mkdir(".research", { recursive: true });
  await writeFile(resolve(".research/public-install-diagnostic.log"), diagnostic, { mode: 0o600 });
  throw error;
} finally {
  if (child && child.exitCode === null) {
    await run(["daemon", "stop"], 10_000).catch(() => {});
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already stopped.
      }
      await Promise.race([closed, new Promise((done) => setTimeout(done, 2000))]);
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already stopped.
        }
        await closed;
      }
    }
  }
  await rm(root, { recursive: true, force: true });
}
