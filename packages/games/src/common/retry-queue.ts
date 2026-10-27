/**
 * Runs a wallet operation per item until it succeeds. Retryable failures are
 * retried with backoff, forever (wallet idempotency makes repeats safe);
 * final failures are reported for manual review.
 */
import { WalletError } from "@kokeb/wallet-contract";

export interface RetryQueueOptions<T> {
  key: (item: T) => string;
  run: (item: T) => Promise<void>;
  onFailed: (item: T, reason: string) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class RetryQueue<T> {
  private readonly opts: RetryQueueOptions<T>;
  private readonly inFlight = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(opts: RetryQueueOptions<T>) {
    this.opts = opts;
  }

  get pending(): number {
    return this.inFlight.size;
  }

  enqueue(item: T): void {
    const k = this.opts.key(item);
    if (this.inFlight.has(k)) return;
    this.inFlight.add(k);
    void this.attempt(item, k, 0);
  }

  async drain(timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private async attempt(item: T, k: string, tries: number): Promise<void> {
    if (this.stopped) return;
    try {
      await this.opts.run(item);
      this.inFlight.delete(k);
    } catch (err) {
      if (err instanceof WalletError && !err.retryable) {
        this.inFlight.delete(k);
        this.opts.onFailed(item, `${err.code}: ${err.message}`);
        return;
      }
      const delay = Math.min((this.opts.baseDelayMs ?? 500) * 2 ** tries, this.opts.maxDelayMs ?? 30_000);
      const t = setTimeout(() => {
        this.timers.delete(t);
        void this.attempt(item, k, tries + 1);
      }, delay);
      this.timers.add(t);
    }
  }
}
