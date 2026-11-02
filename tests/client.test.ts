import { afterEach, expect, it, vi } from "vitest";
import { connectMenubar } from "../client/connect";
import { deferred } from "./helpers";

afterEach(() => vi.useRealTimers());

it("retries bootstrap with backoff, stops after success, and cleans up", async () => {
  vi.useFakeTimers();
  const call = vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValue(undefined);
  const close = connectMenubar(call);
  await vi.advanceTimersByTimeAsync(1000);
  expect(call).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(call).toHaveBeenCalledTimes(2);
  close();
});

it("does not retry a failed in-flight RPC after client disposal", async () => {
  vi.useFakeTimers();
  const pending = deferred<void>();
  const call = vi.fn(() => pending.promise);
  const close = connectMenubar(call);
  close();
  pending.reject(new Error());
  await vi.advanceTimersByTimeAsync(60_000);
  expect(call).toHaveBeenCalledTimes(1);
});
