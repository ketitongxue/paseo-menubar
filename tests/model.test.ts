import { describe, expect, it } from "vitest";
import { cleanText, makeFrame, taskFromAgent } from "../server/model";
import { agent } from "./helpers";

describe("task projection", () => {
  it("distinguishes running, initializing, attention-completed and genuinely idle", () => {
    expect(taskFromAgent(agent())?.status).toBe("idle");
    expect(taskFromAgent(agent({ status: "running" }))?.status).toBe("running");
    expect(taskFromAgent(agent({ status: "initializing" }))?.status).toBe("initializing");
    expect(
      taskFromAgent(agent({ requiresAttention: true, attentionReason: "finished" }))?.status,
    ).toBe("done");
    expect(taskFromAgent(agent({ attentionReason: "finished" }))?.status).toBe("idle");
    expect(taskFromAgent(agent({ status: "error" }))?.status).toBe("error");
    expect(taskFromAgent(agent({ providerUnavailable: true }))?.status).toBe("error");
  });

  it("prioritizes permission requests above a running lifecycle", () => {
    expect(
      taskFromAgent(
        agent({
          status: "running",
          pendingPermissions: [{ id: "p", secret: "NEVER_COPY" }] as unknown as ReturnType<
            typeof agent
          >["pendingPermissions"],
        }),
      )?.status,
    ).toBe("permission");
    expect(
      taskFromAgent(agent({ requiresAttention: true, attentionReason: "permission" }))?.status,
    ).toBe("permission");
  });

  it("never counts archived, closed or internal helpers", () => {
    for (const value of [
      agent({ archivedAt: "2026-01-01" }),
      agent({ status: "closed" }),
      agent({ internal: true }),
    ])
      expect(taskFromAgent(value)).toBeNull();
  });

  it("only forwards minimal display data and safe deep links", () => {
    const projected = taskFromAgent(
      agent({
        id: "id/# ?中文",
        title: " hello\nworld\u202E\u0007 ",
        lastError: "SENSITIVE_ERROR_BODY",
        labels: { secret: "SENSITIVE_LABEL" },
        activeTurn: { turnId: "t", startedAt: "invalid" },
      }),
      "server/# ?",
    );
    expect(projected).toMatchObject({ title: "hello world", project: "project", startedAt: null });
    expect(projected?.url).toBe(
      "paseo://h/server%2F%23%20%3F/agent/id%2F%23%20%3F%E4%B8%AD%E6%96%87",
    );
    const encoded = JSON.stringify(projected);
    expect(encoded).not.toContain("SENSITIVE");
    expect(encoded).not.toContain("/example");
    expect(encoded).not.toContain("pendingPermissions");
    expect(cleanText("a".repeat(200))).toHaveLength(120);
    // Cutting a UTF-16 surrogate pair would make Swift's JSONDecoder reject the whole frame.
    expect(cleanText(`${"a".repeat(119)}🧪more`)).toBe(`${"a".repeat(119)}🧪`);
  });

  it("counts the whole directory before capping the menu, sorts attention first", () => {
    const tasks = Array.from({ length: 220 }, (_, i) =>
      taskFromAgent(agent({ id: String(i), status: i === 219 ? "error" : "running" })),
    ).filter((task) => task !== null);
    const frame = makeFrame(tasks, "connected", "", 42);
    expect(frame.tasks).toHaveLength(100);
    expect(frame.counts).toMatchObject({ running: 219, error: 1, done: 0 });
    expect(frame.omitted).toBe(120);
    expect(frame.tasks[0].id).toBe("219");
    expect(frame.updatedAt).toBe(42);
  });
});
