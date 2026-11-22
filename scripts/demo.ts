import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeBridge } from "../server/bridge";
import { makeFrame } from "../server/model";
import { prepareNative } from "../server/native";
import type { MenuTask, MenuUsage } from "../shared/state";

// Synthetic data only; no daemon connection, credentials, or production plugin installation.
const root = await mkdtemp(join(tmpdir(), "paseo-menubar-demo-"));
let timer: ReturnType<typeof setInterval>;
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  await bridge.close();
  await rm(root, { recursive: true, force: true });
};
const bridge = new NativeBridge({
  root,
  prepare: () => prepareNative(),
  onCommand(command) {
    if (command === "hide") void stop();
  },
});
let step = 0;
const update = () => {
  const task: MenuTask = {
    id: "demo",
    title: "示例：实现菜单栏插件（合成数据）",
    provider: "codex",
    project: "paseo-menubar",
    status: ["running", "permission", "done"][step % 3] as MenuTask["status"],
    updatedAt: Date.now(),
    startedAt: Date.now() - 35_000,
    url: null,
  };
  const now = Date.now();
  const usage: MenuUsage = {
    status: "ready",
    message: "",
    fetchedAt: now,
    omitted: 0,
    accounts: [
      {
        id: "codex",
        name: "Codex (demo@example.com)",
        status: "available",
        plan: "plus",
        message: "",
        windows: [
          {
            id: "five_hour",
            label: "5-hour",
            shortLabel: "5h",
            summary: true,
            usedPct: 12,
            remainingPct: 88,
            resetsAt: now + 3 * 3_600_000,
            tone: "ok",
          },
          {
            id: "weekly",
            label: "Weekly",
            shortLabel: "wk",
            summary: true,
            usedPct: 45,
            remainingPct: 55,
            resetsAt: now + 3 * 86_400_000,
            tone: "ok",
          },
        ],
        balances: [],
      },
    ],
  };
  bridge.send(makeFrame([task], "connected", "", now, 100, usage));
  step++;
};
try {
  update();
  await bridge.start();
  timer = setInterval(update, 5000);
  console.log("菜单栏演示已启动：每 5 秒切换运行 / 等待授权 / 已完成。Ctrl+C 退出。");
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} catch (error) {
  await stop();
  throw error;
}
