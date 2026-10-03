/** The Worker cron remains unchanged; this is the Node process's tick lifecycle. */
export const POLL_INTERVAL_MS = 60_000;

export interface SchedulerClock {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: SchedulerClock = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => {
    clearInterval(handle as NodeJS.Timeout);
  },
};

export interface SchedulerJobs {
  poll(): Promise<void>;
  climate(): Promise<void>;
}

export function createNodeScheduler(
  jobs: SchedulerJobs,
  options: {
    clock?: SchedulerClock;
    intervalMs?: number;
    onError?: (job: "poll" | "climate", error: unknown) => void;
  } = {},
) {
  const clock = options.clock ?? systemClock;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0)
    throw new Error("scheduler interval must be positive");
  const onError =
    options.onError ??
    ((job: "poll" | "climate", error: unknown) => {
      console.error(`[node] ${job} tick failed`, error);
    });
  let timer: unknown;
  let started = false;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const tick = (): void => {
    if (!started || stopped || inFlight !== null) return;
    inFlight = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => jobs.poll()),
        Promise.resolve().then(() => jobs.climate()),
      ]);
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected")
          onError(index === 0 ? "poll" : "climate", result.reason);
      }
    })().finally(() => {
      inFlight = null;
    });
  };

  return {
    start(): void {
      if (started || stopped) throw new Error("scheduler can start only once");
      started = true;
      timer = clock.setInterval(tick, intervalMs);
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (started) clock.clearInterval(timer);
      await inFlight;
    },
  };
}
