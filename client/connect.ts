// The SDK only exposes the server-owned PaseoApi inside a handler or lifecycle event.
// Bootstrap once from any connected client; the observation then outlives that client.
export function connectMenubar(call: () => Promise<unknown>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 1_000;
  const connect = async () => {
    try {
      await call();
    } catch {
      if (!stopped) {
        timer = setTimeout(() => void connect(), delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  };
  void connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
