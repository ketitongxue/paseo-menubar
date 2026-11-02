import type { PluginServerContext } from "@getpaseo/plugin/server";
import { NativeBridge } from "./server/bridge";
import { TaskObserver } from "./server/observer";
import { startMenubar } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  if (process.platform !== "darwin") {
    server.handle(startMenubar, () => ({ supported: false }));
    console.info("Paseo Menu Bar: 请安装在有图形登录会话的 macOS daemon 上。");
    return () => {};
  }
  const observer = new TaskObserver((frame) => bridge.send(frame));
  const bridge = new NativeBridge({
    onCommand(command) {
      if (command === "refresh") void observer.refresh().catch(() => {});
    },
  });
  bridge.send(observer.snapshot());
  void bridge.start().catch(() => {
    console.error("Paseo Menu Bar: 原生组件启动失败；请确认已安装 Apple Command Line Tools。");
  });
  server.handle(startMenubar, async (_, { paseo }) => {
    await Promise.all([observer.ensure(paseo), bridge.start()]);
    return { supported: true };
  });
  // Legacy event names are supported by both 0.14 and 0.15. These hooks do not
  // wait for, veto, or modify operations; they only obtain the server-owned API.
  const removers = (
    [
      "agent.created",
      "agent.closed",
      "agent.archived",
      "agent.turn_started",
      "agent.turn_ended",
      "agent.permission_requested",
      "agent.permission_resolved",
      "workspace.created",
      "workspace.archived",
    ] as const
  ).map((name) =>
    server.on(name, (_, { paseo }) => {
      void observer.ensure(paseo).catch(() => {});
    }),
  );
  return async () => {
    for (const remove of removers) remove();
    await Promise.all([observer.close(), bridge.close()]);
  };
}
