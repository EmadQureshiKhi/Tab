/**
 * `GET /api/stream` - Verified Settlements pushed as they are indexed (R24.6).
 *
 * The adapter, and only the adapter. Every decision about what counts as new, what
 * order frames go out in and what happens when the registry is down lives in
 * `api-stream.ts` and is tested without a server. What is here is the part that
 * genuinely needs the host: a `ReadableStream`, an interval, and an abort signal.
 *
 * The abort handling is the part worth reading. A browser that closes the tab
 * aborts the request, and without clearing the interval the poll would keep reading
 * the registry for a reader who left. That is a leak that only shows up under real
 * traffic, so the teardown is wired to both the signal and the stream's own
 * `cancel`.
 *
 * Requirements: 24.6, 24.9
 */

import {
  HEARTBEAT_MS,
  SSE_HEADERS,
  STREAM_POLL_MS,
  sseComment,
  streamReader,
  streamTick,
} from "../../../src/dashboard/api-stream";
import { registry } from "../../_lib/context";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const url = new URL(request.url);
  const read = streamReader(registry(), url.searchParams);

  let seen: ReadonlySet<string> = new Set<string>();
  let first = true;

  const encoder = new TextEncoder();
  let poll: ReturnType<typeof setInterval> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const stop = (): void => {
        if (closed) return;
        closed = true;
        if (poll !== undefined) clearInterval(poll);
        if (beat !== undefined) clearInterval(beat);
        try {
          controller.close();
        } catch {
          // Already closed by the host. Nothing to do, and nothing to report: the
          // only goal here is that the intervals above are gone.
        }
      };

      const push = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The reader went away between the tick and the write.
          stop();
        }
      };

      const tick = async (): Promise<void> => {
        if (closed) return;
        const result = await streamTick(read, seen, { first });
        first = false;
        seen = result.seen;
        for (const frame of result.frames) push(frame);
      };

      request.signal.addEventListener("abort", stop);
      void tick();
      poll = setInterval(() => void tick(), STREAM_POLL_MS);
      beat = setInterval(() => push(sseComment("keep-alive")), HEARTBEAT_MS);
    },

    cancel() {
      if (poll !== undefined) clearInterval(poll);
      if (beat !== undefined) clearInterval(beat);
    },
  });

  return new Response(stream, { status: 200, headers: { ...SSE_HEADERS } });
}
