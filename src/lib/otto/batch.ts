/**
 * Runs `fn` over `items` with at most `concurrency` in flight at once.
 * Firing hundreds of Finnhub calls via a single Promise.all cascades into
 * mass 429s the instant the pool gets wide (each key is capped at 60
 * req/min) — a bounded worker pool lets the reactive key-rotation in
 * finnhub.ts actually keep pace instead of every request racing for the
 * same exhausted key simultaneously.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
