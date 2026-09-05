"use client";

/**
 * The questions a reader has after the diagrams, answered in their own words.
 *
 * Title on the left and the questions on the right, because a reader scans the
 * questions rather than reading them in order and a column of them is faster to
 * scan than a full-width list.
 *
 * It is a real disclosure and it is written as one. Where the honest answer is a
 * limit rather than a feature, the limit is the answer: what Tab does not do is
 * more useful to somebody deciding whether to build on it than another sentence
 * about what it does.
 *
 * Built on `details` and `summary` rather than on a scripted accordion. They open
 * with no JavaScript at all, they are keyboard operable and announced correctly
 * without a single ARIA attribute, and the browser's own find-in-page can reach
 * text inside a closed one.
 */

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { Reveal, RevealGroup, RevealItem } from "../motion/reveal";
import { Link } from "../ui/link";

interface Question {
  readonly question: string;
  readonly answer: ReactNode;
}

const QUESTIONS: readonly Question[] = [
  {
    question: "What is Tab, and who is it for?",
    answer: (
      <>
        Tab is post-paid billing and a credit facility for autonomous agents. There are two ends to
        it.
        <div className="mt-3 space-y-2">
          <div>
            <strong>An Agent that wants to use paid tools.</strong> It is served before it pays,
            settles later in USDC from its own keys, and builds a Credit Limit out of its own
            settlement history rather than a deposit.
          </div>
          <div>
            <strong>A Service that wants to charge for them.</strong> It records a Metered Delivery
            as the work goes out, and is paid on a Settlement Window it chooses.
          </div>
        </div>
      </>
    ),
  },
  {
    question: "What does post-paid actually mean here?",
    answer: (
      <>
        No payment blocks a call. The Service delivers the work and records the charge against an
        Open Tab on Creditcoin afterwards, and the Agent settles whenever it chooses inside the
        Settlement Window. Nothing is escrowed, and no balance is topped up in advance.
      </>
    ),
  },
  {
    question: "Who decides that a payment happened?",
    answer: (
      <>
        A Creditcoin contract, by reading the Ethereum transaction itself through the Attestcoin
        BlockProver Precompile. No facilitator, oracle or bridge asserts it, and no component of Tab
        is allowed to. That is the removal test on the page above: take the verification away and
        the only thing left is an operator signing a claim, which is what Tab exists to remove.
      </>
    ),
  },
  {
    question: "Where does the Credit Limit come from?",
    answer: (
      <>
        From the Agent&apos;s own history of Verified Settlements, plus the Bond the Services it
        settled with have staked. It is recomputed from logged records rather than assigned, and the
        read API serves a figure only where the contract agrees with it at the same block.
      </>
    ),
  },
  {
    question: "Does Tab ever hold my keys or my funds?",
    answer: (
      <>
        No. Settlement is a transaction the Agent signs on the Source Chain, and nothing in the SDK,
        the command line tool or this site can move an Agent&apos;s funds. Connecting a client
        writes one configuration entry and no key.
      </>
    ),
  },
  {
    question: "What happens if a Service claims a payment that never arrives?",
    answer: (
      <>
        A Provisional Clearing frees the Agent&apos;s headroom immediately and pledges the
        Service&apos;s Bond to cover the claim. If no proof confirms it before the deadline, anyone
        may reverse it: the tab is restored and the pledge becomes prepaid credit for the Agent. The
        party that made the claim is the party that pays for it.
      </>
    ),
  },
  {
    question: "How long does verification take?",
    answer: (
      <>
        As long as the Source Chain takes to be attested, which on Ethereum Mainnet is roughly 13 to
        15 minutes. The Agent is not waiting on it: the Provisional Clearing returns its headroom in
        the meantime, and the proof settles the record afterwards.
      </>
    ),
  },
  {
    question: "What does it cost to use?",
    answer: (
      <>
        Each Service sets its own price per tool, in integer base units of one Asset. Tab adds no fee
        of its own. The only other cost is gas, on the Source Chain to settle and on Creditcoin to
        prove.
      </>
    ),
  },
  {
    question: "Can value ever move back from Creditcoin to Ethereum?",
    answer: (
      <>
        Not today, and Tab is built not to need it. Money moves one way: the Agent pays on the Source
        Chain with its own key, and Creditcoin reads that payment. Anything Tab owes back is settled
        in Creditcoin accounting, so an overpayment becomes prepaid credit rather than a refund. The
        return direction is on the Attestcoin Protocol&rsquo;s roadmap, and the seam for it is already
        in the contracts: <code className="font-mono text-xs">IOutboxAdapter</code> declares the
        publications a credit facility would make and implements none of them, so connecting it later
        is wiring rather than a redesign.
      </>
    ),
  },
];

export interface FaqSectionProps {
  /** Where the longer answers live. The documentation is its own deployment. */
  readonly docsUrl: string;
}

export function FaqSection({ docsUrl }: FaqSectionProps) {
  return (
    <section className="grid items-start gap-8 md:grid-cols-2 md:gap-12">
      <Reveal from="left" className="flex flex-col gap-1">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Questions
        </p>
        <h2 className="font-host text-2xl leading-tight font-bold text-foreground sm:text-3xl">
          Frequently asked
          <br />
          questions
        </h2>
        {/*
          The column beside a two-line heading is otherwise empty for the whole
          height of the accordion, which at a desktop width is most of a screen of
          nothing. This says what the answers have in common and points at the
          longer version, which is what a reader who did not find their question
          in the list actually needs.
        */}
        <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Every answer below is checkable. Where one names a figure, that figure is read
          from Creditcoin, and the pages on this site show the read it came from rather
          than a summary of it.
        </p>
        <Link
          href={docsUrl}
          external
          className="mt-5 w-fit font-mono text-xs tracking-widest uppercase"
          size="xs"
        >
          Read the documentation
        </Link>
      </Reveal>

      <RevealGroup className="flex flex-col gap-3">
        {QUESTIONS.map((entry) => (
          <RevealItem key={entry.question} from="right">
            <details className="group rounded-md border border-border/60 bg-muted/30 transition-colors duration-300 open:bg-muted/50 hover:border-border">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3.5 [&::-webkit-details-marker]:hidden">
                <span className="font-mono text-sm leading-relaxed text-muted-foreground uppercase transition-colors duration-300 group-open:text-foreground group-hover:text-foreground">
                  {entry.question}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform duration-300 group-open:rotate-180"
                />
              </summary>
              <div className="px-4 pb-4 text-sm leading-relaxed text-foreground">{entry.answer}</div>
            </details>
          </RevealItem>
        ))}
      </RevealGroup>
    </section>
  );
}
