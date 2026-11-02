import type { PluginClientContext } from "@getpaseo/plugin/client";
import { connectMenubar } from "./client/connect";
import { startMenubar } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  return connectMenubar(() => client.rpc(startMenubar, {}));
}
