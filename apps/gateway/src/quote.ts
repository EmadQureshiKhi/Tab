/**
 * What the demo Service's `quote.generate` actually delivers: one short line on the
 * topic the caller asks about.
 *
 * The rail does not care what a Service sells, only that it is delivered before it is
 * metered. But an Agent that pays for a quote and gets back a bare receipt has been
 * charged for nothing it can use, so the demo hands over something real: a line chosen
 * by topic, the same line for the same topic, written for this project.
 */

interface Quote {
  readonly topic: string;
  readonly text: string;
}

const LINES: readonly { readonly match: RegExp; readonly lines: readonly string[] }[] = [
  {
    match: /credit|limit|borrow|loan/i,
    lines: [
      "Credit is trust with a ledger: you are believed today because you paid yesterday.",
      "A credit limit is a memory of every promise kept, written where anyone can read it.",
      "Good credit is not a gift. It is the shape your past payments leave behind.",
    ],
  },
  {
    match: /pay|settle|tab|bill|debt/i,
    lines: [
      "Pay for what you used, once you have used it, and the bill can never be a guess.",
      "A tab that closes on time is the cheapest reputation there is.",
      "Settling is the moment a promise becomes a fact.",
    ],
  },
  {
    match: /trust|agent|reputation/i,
    lines: [
      "Trust is earned one settlement at a time, and spent one default at a time.",
      "An agent is trusted the way a person is: by what it did, not by what it says.",
    ],
  },
];

const ANYTHING: readonly string[] = [
  "The best service is the one you only pay for after it has worked.",
  "Work first, bill second, and let the ledger keep everyone honest.",
];

/** A small, stable hash, so a topic always draws the same line. */
function pick(lines: readonly string[], topic: string): string {
  let hash = 0;
  for (const ch of topic.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return lines[hash % lines.length] ?? lines[0] ?? "";
}

/** The quote for a topic; an empty or missing topic gets a general line. */
export function quoteFor(topic: unknown): Quote {
  const asked = typeof topic === "string" ? topic.trim().slice(0, 200) : "";
  const group = LINES.find((entry) => entry.match.test(asked));
  return { topic: asked === "" ? "anything" : asked, text: pick(group?.lines ?? ANYTHING, asked) };
}

/** The topic in a request body: `prompt`, `topic` or `subject`, whichever the caller used. */
export function topicOf(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  return record["prompt"] ?? record["topic"] ?? record["subject"];
}
