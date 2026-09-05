"use client";

/**
 * The hero, in the reference's two-column shape.
 *
 * Words and calls to action on the left, the turning mark on the right, and the
 * live figures pinned to the bottom of the left column so the two columns finish
 * at the same line. On a narrow screen the order changes rather than the layout
 * squeezing: heading, mark, actions, figures.
 *
 * The figures are the argument. A landing page that claims a rail works and shows
 * nothing is a brochure, so the count and the volume are read from the same index
 * the explorer reads, and they are the first thing under the heading that a reader
 * can go and check.
 */

import { motion, useReducedMotion } from "motion/react";

import { Button } from "../ui/button";
import { Logo3D } from "../motion/logo-3d";
import { NumberTicker } from "../motion/number-ticker";
import { SplitHeading } from "../motion/split-heading";

export interface HeroStat {
  readonly label: string;
  readonly value: string;
  readonly target?: number;
}

export interface HeroProps {
  readonly heading: string;
  readonly body: string;
  readonly stats: readonly HeroStat[];
}

export function Hero({ heading, body, stats }: HeroProps) {
  const reduced = useReducedMotion() === true;
  const fade = {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: reduced ? 0 : 0.5, ease: [0.22, 1, 0.36, 1] as const },
  };

  return (
    <section className="relative py-2 sm:py-6 lg:py-10">
      {/*
        A single soft light behind the hero, and nothing else on the page.
        It sits under the content at low opacity and is masked to a radial falloff,
        so it reads as the mark lighting the ground rather than as a coloured panel.
        `aria-hidden` and `pointer-events-none`: it is atmosphere, and it must never
        take a click or be read out.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        {/*
          Clipped by the wrapper rather than sized to fit. A glow wide enough to
          fall off both edges is what makes it read as light rather than as a
          shape, and without the clip that extra width scrolled the page sideways
          by 20px at 390 and 48px at 768.
        */}
        <div
          className="absolute -top-24 left-1/2 h-[520px] w-[min(1100px,140%)] -translate-x-1/2 opacity-60 dark:opacity-45"
          style={{
            background:
              "radial-gradient(ellipse 60% 50% at 70% 40%, rgb(20 184 166 / 0.16), transparent 70%)",
          }}
        />
      </div>
      <div className="flex flex-col gap-8 lg:grid lg:min-h-[460px] lg:grid-cols-2 lg:items-stretch lg:gap-12">
        <div className="order-1 flex flex-col gap-1 lg:hidden">
          <SplitHeading className="font-host text-3xl leading-tight font-semibold text-foreground">
            {heading}
          </SplitHeading>
          <motion.p {...fade} className="max-w-lg text-sm leading-relaxed text-foreground/80">
            {body}
          </motion.p>
        </div>

        <div className="order-2 lg:hidden">
          <Logo3D className="h-[300px]" delay={reduced ? 0 : 0.4} />
        </div>

        <motion.div {...fade} className="order-3 flex flex-col gap-4 lg:hidden">
          <Actions />
        </motion.div>

        <motion.div {...fade} className="order-4 lg:hidden">
          <Stats stats={stats} />
        </motion.div>

        <div className="hidden lg:order-1 lg:flex lg:h-full lg:flex-col lg:justify-between lg:gap-10">
          <div className="flex max-w-xl flex-col gap-3">
            <SplitHeading className="font-host text-4xl leading-tight font-semibold text-foreground xl:text-5xl">
              {heading}
            </SplitHeading>
            <motion.p
              {...fade}
              transition={{ ...fade.transition, delay: reduced ? 0 : 0.15 }}
              className="text-base leading-relaxed text-foreground/80"
            >
              {body}
            </motion.p>
            <motion.div
              {...fade}
              transition={{ ...fade.transition, delay: reduced ? 0 : 0.25 }}
              className="flex flex-wrap gap-4 pt-6"
            >
              <Actions />
            </motion.div>
          </div>

          <motion.div {...fade} transition={{ ...fade.transition, delay: reduced ? 0 : 0.35 }}>
            <Stats stats={stats} />
          </motion.div>
        </div>

        <div className="hidden lg:order-2 lg:block lg:h-full">
          <Logo3D className="h-full" delay={reduced ? 0 : 0.4} />
        </div>
      </div>
    </section>
  );
}

function Actions() {
  return (
    <>
      <Button asChild variant="customTallPrimary" size="tall" className="w-full lg:w-auto lg:min-w-[220px]">
        <a href="/explorer" className="no-underline">
          OPEN THE EXPLORER
        </a>
      </Button>
      <Button asChild variant="customTallSecondary" size="tall" className="w-full lg:w-auto lg:min-w-[220px]">
        <a href="/services" className="no-underline">
          BROWSE SERVICES
        </a>
      </Button>
    </>
  );
}

function Stats({ stats }: { readonly stats: readonly HeroStat[] }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-sm tracking-wider text-muted-foreground uppercase">
      {stats.map((stat) => (
        <div key={stat.label} className="flex items-baseline gap-2">
          <dt>{stat.label}:</dt>
          <dd className="font-medium text-foreground">
            <NumberTicker value={stat.value} {...(stat.target === undefined ? {} : { target: stat.target })} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
