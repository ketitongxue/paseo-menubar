import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// Derive API types from the host-provided server SDK. Direct @getpaseo/client
// imports (even type-only) cannot resolve in a production-only plugin install.
export type PaseoApi = PluginHandlerContext["paseo"];
export type PaseoAgent = NonNullable<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["current"]>>;
export type PaseoAgentListOptions = NonNullable<Parameters<PaseoApi["agents"]["list"]>[0]>;
export type PaseoAgentListResult = Awaited<ReturnType<PaseoApi["agents"]["list"]>>;
export type AgentSubscription = NonNullable<PaseoAgentListResult["subscription"]>;
