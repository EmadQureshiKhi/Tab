/**
 * `/` - what Tab is, and what it has actually verified.
 *
 * The landing route carries the removal test, because that is the claim the whole
 * system is built to support, and then immediately shows the Verified Settlements
 * that back it. An explainer with no evidence under it is marketing; the evidence
 * is the point, and it is two scrolls away rather than on another page.
 *
 * The hero's figures come from the same index the explorer reads, so a reader who
 * doubts them can go and check every row they are a total of.
 *
 * Requirements: 24.6, 24.9, 29.2
 */

import { EmptyChain } from "../components/views/empty-chain";
import { LiveSettlements } from "../components/views/live-settlements";
import { Hero } from "../components/shell/hero";
import { ClientFlow } from "../components/motion/client-flow";
import { Parallax } from "../components/motion/parallax";
import { ClosingCta } from "../components/shell/closing-cta";
import { FaqSection } from "../components/shell/faq-section";
import { SdkSection } from "../components/shell/sdk-section";
import { SetupSection } from "../components/shell/setup-section";
import { WorksWith } from "../components/shell/works-with";
import { SettlementWalkthrough } from "../components/motion/settlement-walkthrough";
import { Reveal, RevealGroup, RevealItem } from "../components/motion/reveal";
import { toSettlementViews } from "../src/dashboard/views";
import { docsUrl, explorerBaseUrl, routeContext, type SearchParams } from "./_lib/context";

export const dynamic = "force-dynamic";

const REMOVAL_TEST = [
  {
    heading: "A Service meters first and is paid later",
    body: "Usage is recorded into an Open Tab on Creditcoin as the work is delivered. Nothing is prepaid, and no payment blocks a call.",
  },
  {
    heading: "The Agent settles on Ethereum with its own keys",
    body: "Value moves on the Source Chain by the Agent's own signature. No component of Tab can move an Agent's funds.",
  },
  {
    heading: "A Creditcoin contract verifies that payment itself",
    body: "The SettlementVerifier proves the Ethereum transaction, its receipt and its logs through the BlockProver Precompile before any tab moves. No facilitator, oracle or bridge asserts that money arrived.",
  },
];

export default async function OverviewPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const context = routeContext(await searchParams);
  const page = await context.registry.settlements({ chainKey: context.chainKey, limit: 10 });

  // Two figures, both read from the index rather than counted here, and both
  // stated as unavailable rather than as zero when the read failed. A dash is the
  // honest rendering of "not known"; a zero is a claim.
  const settled = page.ok ? page.value.settlements.length : null;
  const indexedBlock = page.ok ? page.value.index.lastBlock : null;

  return (
    <div className="flex flex-col gap-20 sm:gap-28 lg:gap-32">
      <Hero
        heading="Post-paid billing for autonomous agents, verified on Creditcoin"
        body="An Agent is served before it pays, settles on Ethereum with its own keys, and a Creditcoin contract proves that payment itself. No facilitator, oracle or bridge asserts that money arrived."
        stats={[
          {
            label: "Settlements shown",
            value: settled === null ? "unavailable" : String(settled),
            ...(settled === null ? {} : { target: settled }),
          },
          {
            label: "Indexed to block",
            value: indexedBlock === null ? "unavailable" : indexedBlock.toLocaleString("en-GB"),
            ...(indexedBlock === null ? {} : { target: indexedBlock }),
          },
        ]}
      />

      {/*
        This section owns its own heading, because the heading has to stay stuck
        to the panel while the page scrolls through it and a wrapper out here
        could not hold both.
      */}
      <SettlementWalkthrough />

      <SetupSection />

      <WorksWith />

      <section className="flex flex-col gap-8">
        <Reveal from="left" className="flex flex-col gap-1">
          <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            What a call looks like
          </p>
          <h2 className="font-host text-2xl font-semibold text-foreground sm:text-3xl">
            The result comes back before the charge does
          </h2>
        </Reveal>
        <Reveal delay={0.08}>
          <Parallax distance={22}>
            <ClientFlow />
          </Parallax>
        </Reveal>
      </section>

      <section aria-labelledby="removal-test" className="flex flex-col gap-4">
        <Reveal>
          <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            Why it holds
          </p>
          <h2
            id="removal-test"
            className="mt-1 font-host text-2xl font-semibold text-foreground sm:text-3xl"
          >
            Take the verification away and there is no product
          </h2>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Remove the Attestcoin Protocol from Tab and a Creditcoin contract has no mechanism by
            which to learn that an Ethereum payment occurred. The only path left is an off-chain
            operator signing a claim that funds landed, which is the trusted facilitator Tab exists
            to remove. Tab does not degrade without verification. It inverts into the product it
            replaces.
          </p>
        </Reveal>

        {/*
          Three cards of one argument, so they fan in towards the middle rather
          than all rising together: the outer two travel from the edge they sit
          on and the middle one rises, which reads as the three of them closing
          on the point they make.
        */}
        <RevealGroup className="grid gap-4 md:grid-cols-3">
          {REMOVAL_TEST.map((step, index) => (
            <RevealItem
              key={step.heading}
              as="div"
              from={index === 0 ? "left" : index === 2 ? "right" : "up"}
              className="group relative overflow-hidden rounded-lg border border-border bg-card p-5 transition-colors duration-300 hover:border-border"
            >
              <span className="font-mono text-xs text-teal-700 dark:text-teal-300">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-2 font-host text-sm font-semibold text-foreground">
                {step.heading}
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{step.body}</p>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/25 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-hover:animate-[glare_1.1s_ease-out] dark:via-white/10"
              />
            </RevealItem>
          ))}
        </RevealGroup>
      </section>

      <section aria-labelledby="ticker" className="flex flex-col gap-4">
        <Reveal from="left" className="flex flex-col gap-1">
          <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            Live on {context.chain.network}
          </p>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="ticker" className="font-host text-2xl font-semibold text-foreground sm:text-3xl">
              Verified Settlements on {context.chain.name}
            </h2>
            <p className="font-mono text-xs text-muted-foreground">
              settlement is {context.chain.settlementShape}
            </p>
          </div>
        </Reveal>

        {/*
          The ticker is server-rendered first and then kept fresh by the client
          island, which runs an event stream and a fifteen-second poll together.
          Both, rather than the poll as a fallback the stream falls back to: a
          stream held by a buffering proxy looks exactly like a quiet one from
          inside the page, so there is nothing to detect and fall back from. The
          server render is what makes the rows correct with no client runtime at
          all (R24.6, R24.9).
        */}
        {!page.ok ? (
          <div aria-live="polite">
            <EmptyChain
              message={`The registry could not be read: ${page.error.message}`}
              indexedBlock={null}
            />
          </div>
        ) : page.value.settlements.length === 0 ? (
          <div aria-live="polite">
            <EmptyChain
              message={context.chain.emptyMeans}
              indexedBlock={page.value.index.lastBlock}
            />
          </div>
        ) : (
          <Reveal delay={0.08}>
            <LiveSettlements
              caption={`Verified Settlements on ${context.chain.name}`}
              chainKey={context.chainKey}
              initialRows={toSettlementViews(page.value.settlements)}
              explorerBaseUrl={explorerBaseUrl()}
            />
          </Reveal>
        )}
      </section>

      <SdkSection />

      <FaqSection docsUrl={docsUrl()} />

      <ClosingCta docsUrl={docsUrl()} />
    </div>
  );
}
