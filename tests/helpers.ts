import type {
  OwnedSubscription,
  PaseoAgent,
  PaseoAgentListResult,
  PaseoApi,
  SubscriptionObserver,
} from "@getpaseo/client";
import { vi } from "vitest";

export function agent(overrides: Partial<PaseoAgent> = {}): PaseoAgent {
  return {
    id: "agent-1",
    provider: "codex",
    cwd: "/example/project",
    model: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "测试任务",
    labels: {},
    ...overrides,
  };
}

export function page(
  agents: PaseoAgent[] = [],
  cursor: string | null = null,
): PaseoAgentListResult {
  return {
    requestId: "test",
    entries: agents.map((agent) => ({
      agent,
      project: {
        projectKey: "example",
        projectName: "project",
        checkout: {
          cwd: agent.cwd,
          isGit: false,
          currentBranch: null,
          remoteUrl: null,
          worktreeRoot: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        },
      },
    })),
    pageInfo: { nextCursor: cursor, prevCursor: null, hasMore: cursor !== null },
  };
}

type Snapshot = PaseoAgentListResult & { subscriptionId: string };
export class Subscription implements OwnedSubscription<PaseoAgentListResult> {
  subscriptionId = "subscription-1";
  observer?: SubscriptionObserver<Snapshot>;
  release = vi.fn(async () => {});
  ready: Promise<Snapshot>;
  constructor(public initial: PaseoAgentListResult = page()) {
    this.ready = Promise.resolve({ ...initial, subscriptionId: this.subscriptionId });
  }
  subscribe(observer: SubscriptionObserver<Snapshot>) {
    this.observer = observer;
    observer.snapshot({ ...this.initial, subscriptionId: this.subscriptionId });
    return vi.fn(() => {
      this.observer = undefined;
    });
  }
  snapshot(value: PaseoAgentListResult) {
    this.observer?.snapshot({ ...value, subscriptionId: this.subscriptionId });
  }
  upsert(value: PaseoAgent) {
    this.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: value } });
  }
  remove(id: string) {
    this.observer?.update({ type: "agent_update", payload: { kind: "remove", agentId: id } });
  }
}

export function fakeApi(sub = new Subscription()) {
  const list = vi.fn(async () => ({
    ...sub.initial,
    subscriptionId: sub.subscriptionId,
    subscription: sub,
  }));
  const api = {
    agents: {
      list,
      ref: vi.fn(() => ({ address: { serverId: "server / 中文", agentId: "agent-1" } })),
    },
  } as unknown as PaseoApi;
  return { api, list, sub };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
