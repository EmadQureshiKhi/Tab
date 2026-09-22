/**
 * `/` - what Tab is, and what has actually settled.
 *
 * The landing route carries the removal test, because that is the claim the whole
 * system is built to support, and then immediately shows the Settlements that
 * back it. An explainer with no evidence under it is marketing; the evidence is
 * the point, and it is two scrolls away rather than on another page.
 *
 * The hero's figures come from the same index the explorer reads, so a reader who
 * doubts them can go and check every row they are a total of.
 */

import { EmptyChain } from "../components/views/empty-chain";
import { LiveSettlements } from "../components/views/live-settlements";
import { Hero } from "../components/shell/hero";
import { ClientFlow } from "../components/motion/client-flow";
import { Parallax } from "../components/motion/parallax";
import { SettlementStrip } from "../components/motion/settlement-strip";
import { ClosingCta } from "../components/shell/closing-cta";
import { FaqSection } from "../components/shell/faq-section";
import { SdkSection } from "../components/shell/sdk-section";
import { SetupSection } from "../components/shell/setup-section";
import { WorksWith } from "../components/shell/works-with";
import { SettlementWalkthrough } from "../components/motion/settlement-walkthrough";
import { Reveal, RevealGroup, RevealItem } from "../components/motion/reveal";
import { toSettlementViews } from "../src/dashboard/views";
import { docsUrl, explorerBaseUrl, routeContext } from "./_lib/context";

export const dynamic = "force-dynamic";

const REMOVAL_TEST = [
  {
    heading: "A Service meters first and is paid later",
    body: "Usage is recorded into an Open Tab on Monad as the work is delivered. Nothing is prepaid, and no payment blocks a call.",
  },
  {
    heading: "The Agent settles with its own key",
    body: "The stablecoin moves from the Agent to the Service's collection address by the Agent's own signature. No component of Tab can move an Agent's funds.",
  },
  {
    heading: "The payment and the ledger entry are one transaction",
    body: "TabSettlement moves the Asset and applies the Settlement to the tab in the same Monad transaction. There is no second step, no oracle and no bridge, and the transaction hash is the whole receipt.",
  },
];

export default async function OverviewPage() {
  const context = routeContext();
  const page = await context.registry.settlements({ limit: 10 });

  // Two figures, both read from the index rather than counted here, and both
  // stated as unavailable rather than as zero when the read failed. A dash is the
  // honest rendering of "not known"; a zero is a claim.
  const settled = page.ok ? page.value.settlements.length : null;
  const indexedBlock = page.ok ? page.value.index.lastBlock : null;
  // The strip is handed the newest Settlement's block where there is one, so the
  // figure it animates is a real one. Where nothing has settled it shows the
  // indexed head, which is still a fact about the chain rather than a placeholder.
  const stripBlock = page.ok ? (page.value.settlements[0]?.monad.blockNumber ?? indexedBlock) : null;

  return (
    <div className="flex flex-col gap-20 sm:gap-28 lg:gap-32">
      <Hero
        heading="Post-paid billing for autonomous agents, settled on Monad"
        body="An Agent is served before it pays, settles in stablecoin with its own key, and the payment and the ledger entry land in one Monad transaction. Nothing asserts that money arrived, because the transaction that moved it is the one that recorded it."
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

      <section className="flex flex-col gap-8">
        <Reveal from="left" className="flex flex-col gap-1">
          <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            One transaction
          </p>
          <h2 className="font-host text-2xl font-semibold text-foreground sm:text-3xl">
            The payment is the record
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            <code className="font-mono">TabSettlement.settle</code> pulls the Asset from the Agent, pays it to the Service&apos;s
            collection address, and calls <code className="font-mono">TabBook.applySettlement</code> before the transaction ends. If
            any part of that reverts, all of it does. A Settlement either happened in full on Monad
            or it did not happen.
          </p>
        </Reveal>
        <Reveal delay={0.08}>
          <SettlementStrip
            blockNumber={stripBlock === null ? "unavailable" : stripBlock.toLocaleString("en-GB")}
          />
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
            Take the atomic settlement away and there is no product
          </h2>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Split the payment from the ledger entry and a Service has no mechanism by which to learn
            that it was paid, other than an off-chain operator asserting that funds landed, which is
            the trusted facilitator Tab exists to remove. Tab does not degrade without same-chain
            settlement. It inverts into the product it replaces.
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
            Live on {context.network.shortName}
          </p>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="ticker" className="font-host text-2xl font-semibold text-foreground sm:text-3xl">
              Settlements on {context.network.name}
            </h2>
            <p className="font-mono text-xs text-muted-foreground">
              chain {context.chainId} · gas in MON
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
          all.
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
              message={context.network.emptyMeans}
              indexedBlock={page.value.index.lastBlock}
            />
          </div>
        ) : (
          <Reveal delay={0.08}>
            <LiveSettlements
              caption={`Settlements on ${context.network.name}`}
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
