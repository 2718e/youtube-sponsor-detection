// A cap on how many model requests are in flight at once.
//
// A local server is easily overloaded when every transcript window is asked at
// the same time, so the provider holds each request, retries included, until a
// slot is free. The limit belongs to the server being asked, not to any one
// provider object: a second provider pointed at the same endpoint shares the
// same slots (the extension builds one per analysis).

export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
  setMax(max: number): void;
}

/** A whole number of at least one, or the fallback. */
function normaliseMax(value: number, fallback: number): number {
  const max = Math.floor(Number(value));
  return Number.isFinite(max) && max >= 1 ? max : fallback;
}

export function createLimiter(max: number): Limiter {
  let limit = normaliseMax(max, 1);
  let active = 0;
  const waiting: (() => void)[] = [];

  const start = () => {
    active += 1;
  };

  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      start();
      next();
    }
  };

  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < limit) {
        start();
        resolve();
      } else {
        waiting.push(resolve);
      }
    });

  return {
    async run(task) {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },

    setMax(next) {
      limit = normaliseMax(next, limit);
      while (active < limit && waiting.length) {
        start();
        waiting.shift()!();
      }
    }
  };
}

const shared = new Map<string, Limiter>();

/** The limiter for one endpoint, created on first use and shared from then on. */
export function limiterFor(endpoint: string, max: number): Limiter {
  let limiter = shared.get(endpoint);
  if (!limiter) shared.set(endpoint, (limiter = createLimiter(max)));
  else limiter.setMax(max);
  return limiter;
}

/** Forget every shared limiter. Tests need a clean slate; a process does not. */
export function resetLimiters(): void {
  shared.clear();
}
