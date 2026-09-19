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
        Tab is post-paid billing and a credit facility for autonomous agents, on Monad. There are
        two ends to it.
        <div className="mt-3 space-y-2">
          <div>
            <strong>An Agent that wants to use paid tools.</strong> It is served before it pays,
            settles later in USDC or AUSD from its own key, and builds a Credit Limit out of its
            own settlement history rather than a deposit.
          </div>
          <div>
            <strong>A Service that wants to charge for them.</strong> It meters each delivery into
            the Agent&apos;s Open Tab as the work goes out, and is paid on a Settlement Window it
            chooses.
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
        Open Tab in <code className="font-mono text-xs">TabBook</code> afterwards, and the Agent
        settles whenever it chooses inside the Settlement Window. Nothing is deposited up front,
        and no balance is topped up in advance.
      </>
    ),
  },
  {
    question: "How does a Settlement work?",
    answer: (
      <>
        The Agent calls <code className="font-mono text-xs">TabSettlement.settle</code> with the
        Service, the Asset and an amount. In that one Monad transaction the stablecoin moves from
        the Agent to the Service&apos;s collection address and{" "}
        <code className="font-mono text-xs">TabBook</code> applies it to the Open Tab. The
        transaction hash is the whole record. There is no second chain, no facilitator, and
        nothing to confirm afterwards.
      </>
    ),
  },
  {
    question: "Where does the Credit Limit come from?",
    answer: (
      <>
        It is a pure function of what is already on chain: the Agent&apos;s own Settlements, and
        the Bond each counterparty Service has escrowed in that Asset. A brand-new Agent starts
        at a baseline capped by counterparty stake, and the limit grows with every Settlement
        applied. It is recomputed from the record rather than assigned, and the read API serves
        a figure only where the contract agrees with it at the same block.
      </>
    ),
  },
  {
    question: "Does Tab ever hold my keys or my funds?",
    answer: (
      <>
        No. Settlement is a transaction the Agent signs itself, and{" "}
        <code className="font-mono text-xs">TabSettlement</code> holds nothing: the Asset goes
        from the Agent to the Service inside the call. Nothing in the SDK, the command line tool
        or this site can move an Agent&apos;s funds. Connecting a client writes one configuration
        entry and no key.
      </>
    ),
  },
  {
    question: "What happens if an Agent never settles?",
    answer: (
      <>
        Once the Settlement Window closes, anyone may call{" "}
        <code className="font-mono text-xs">TabBook.markDelinquent</code> on the tab. The call is
        permissionless on purpose, so liveness does not depend on the Service. The mark zeroes
        the Agent&apos;s Credit Limit in that Asset until it settles, and the Service&apos;s Bond
        is untouched. The overdue tabs, and the exact command to mark them, are listed on this
        site.
      </>
    ),
  },
  {
    question: "How long does a Settlement take to count?",
    answer: (
      <>
        One Monad block. The payment and the ledger entry are the same transaction, so headroom
        is restored in the block that carries it and the next call goes through. There is no
        waiting period between paying and being served again.
      </>
    ),
  },
  {
    question: "What does it cost to use?",
    answer: (
      <>
        Each Service sets its own price per tool, in integer base units of one Asset. Tab adds no
        fee of its own. The only other cost is gas on Monad, paid in MON, for the one
        transaction that settles.
      </>
    ),
  },
  {
    question: "What does a Service risk?",
    answer: (
      <>
        The unpaid tab, and nothing more. A Service escrows a Bond because free stake is what
        caps the Credit Limit of every Agent that settles with it, not because it is forfeited
        when an Agent fails to pay. Deposits and withdrawals go through{" "}
        <code className="font-mono text-xs">Bond</code> directly, and every change to a
        Service&apos;s terms sits behind a 48-hour timelock in public first.
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
          from Monad, and the pages on this site show the read it came from rather than
          a summary of it.
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
