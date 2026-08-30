/**
 * The long-running half: a poll loop around {@link runTick}, and the state a probe
 * reads.
 *
 * The loop is deliberately dull. It ticks, records what happened, sleeps when it is
 * caught up, and ticks again immediately when it is not, so catch-up runs at chunk
 * speed and steady state runs at the poll interval. A tick that throws is recorded
 * and the loop continues: a transient RPC failure must not end the process, and
 * because every tick re-scans its window and rewrites it, a lost tick costs nothing
 * but latency.
 *
 * Requirements: 12.6, 24.4
 */

import { runTick, type IndexerOptions, type LogSource, type TickReport } from "./indexer.js";
import { DEFAULT_STREAM, type EventSink } from "./sink.js";

export interface ServiceOptions extends IndexerOptions {
  readonly pollIntervalMs: number;
}

/** What a probe can see. Never requires authentication and never carries a secret. */
export interface IndexerStatus {
  readonly stream: string;
  readonly running: boolean;
  /** True once at least one tick has completed, which is what readiness turns on. */
  readonly primed: boolean;
  readonly lastBlock: number | null;
  readonly head: number | null;
  readonly caughtUp: boolean;
  readonly reorgCount: number;
  readonly ticks: number;
  readonly rowsWritten: number;
  readonly logsSkipped: number;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  readonly lastTickAt: string | null;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

export class IndexerService {
  private running = false;
  private primed = false;
  private ticks = 0;
  private rowsWritten = 0;
  private logsSkipped = 0;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lastTickAt: string | null = null;
  private last: TickReport | null = null;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;

  private readonly source: LogSource;
  private readonly sink: EventSink;
  private readonly options: ServiceOptions;

  constructor(source: LogSource, sink: EventSink, options: ServiceOptions) {
    this.source = source;
    this.sink = sink;
    this.options = options;
  }

  get status(): IndexerStatus {
    return {
      stream: this.options.stream ?? DEFAULT_STREAM,
      running: this.running,
      primed: this.primed,
      lastBlock: this.last?.cursor.lastBlock ?? null,
      head: this.last?.head ?? null,
      caughtUp: this.last?.caughtUp ?? false,
      reorgCount: this.last?.cursor.reorgCount ?? 0,
      ticks: this.ticks,
      rowsWritten: this.rowsWritten,
      logsSkipped: this.logsSkipped,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastTickAt: this.lastTickAt,
    };
  }

  /** Runs one tick and folds the result into the status. Failures are recorded, not thrown. */
  async tickOnce(): Promise<TickReport | null> {
    try {
      const report = await runTick(this.source, this.sink, this.options);
      this.ticks += 1;
      this.rowsWritten += report.rowsWritten;
      this.logsSkipped += report.logsSkipped;
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastTickAt = new Date().toISOString();
      this.last = report;
      this.primed = true;
      return report;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.loop = (async () => {
      while (!signal.aborted) {
        const report = await this.tickOnce();
        if (signal.aborted) break;
        // Behind the head: no pause, so catch-up proceeds at chunk speed. At the
        // head, or after a failure: wait out the interval.
        if (report !== null && !report.caughtUp && !report.idle) continue;
        await sleep(this.options.pollIntervalMs, signal);
      }
      this.running = false;
    })();
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loop;
    this.running = false;
  }
}
