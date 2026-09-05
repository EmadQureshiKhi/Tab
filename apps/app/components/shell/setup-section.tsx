"use client";

/**
 * Getting on the rail, in one command.
 *
 * The point of this section is that adoption costs one line, so the line is the
 * section: a prompt an Agent can be handed, and the command that writes the client
 * configuration. Both are copyable, because a reader who has to select a wrapped
 * command by hand will get it wrong.
 *
 * The prompt types itself once on the way in. That is the only decorative motion
 * on the page that touches text a reader needs, so it finishes fast and it is
 * skipped whole under a reduced-motion preference rather than merely sped up.
 */

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "../ui/cn";
import { CopyButton } from "../custom-ui/copy-button";
import { Reveal } from "../motion/reveal";

const MANAGERS = ["pnpm", "npm", "bun"] as const;
type Manager = (typeof MANAGERS)[number];

const COMMANDS: Record<Manager, string> = {
  pnpm: "pnpm dlx @tabai/sdk connect",
  npm: "npx -y @tabai/sdk connect",
  bun: "bunx @tabai/sdk connect",
};

const PROMPT =
  "Connect me to Tab, then use tab_discover to list the Services and call one with tab_call.";


function Typewriter({ text }: { readonly text: string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(text);
  const [done, setDone] = useState(true);

  useEffect(() => {
    if (reduced !== false) {
      setShown(text);
      setDone(true);
      return undefined;
    }
    setShown("");
    setDone(false);
    let index = 0;
    const timer = setInterval(() => {
      index += 1;
      setShown(text.slice(0, index));
      if (index >= text.length) {
        clearInterval(timer);
        setDone(true);
      }
    }, 18);
    return () => clearInterval(timer);
  }, [reduced, text]);

  // The full text is always in the DOM for assistive technology and for a reader
  // whose script never runs; only the visible span is typed.
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {shown}
        {done ? null : <span className="animate-pulse">|</span>}
      </span>
    </>
  );
}

export function SetupSection() {
  const [manager, setManager] = useState<Manager>("pnpm");

  return (
    <Reveal as="section" className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Get started
        </p>
        <h2 className="font-host text-2xl font-semibold text-foreground sm:text-3xl">
          Setup in one minute
        </h2>
      </div>

      <div className="rounded-lg border border-border/60 bg-muted/30 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="mb-2 font-mono text-xs tracking-wider text-muted-foreground uppercase">
              prompt
            </p>
            <p className="font-mono text-sm leading-relaxed break-words text-foreground sm:text-base">
              <Typewriter text={PROMPT} />
            </p>
          </div>
          <CopyButton text={PROMPT} label="the prompt" />
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/30">
        <div className="flex border-b border-border/60" role="tablist" aria-label="Package manager">
          {MANAGERS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={manager === name}
              onClick={() => setManager(name)}
              className={cn(
                "relative px-4 py-3 font-mono text-sm transition-colors sm:px-6",
                manager === name ? "text-foreground" : "text-muted-foreground hover:text-foreground/70",
              )}
            >
              {name}
              {manager === name ? (
                <motion.span
                  layoutId="setup-tab"
                  className="absolute right-0 bottom-0 left-0 h-[2px] bg-foreground"
                  transition={{ duration: 0.2 }}
                />
              ) : null}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 p-4 sm:p-5">
          <code className="min-w-0 flex-1 font-mono text-sm break-all text-foreground/90">
            <span className="text-muted-foreground select-none">$ </span>
            {COMMANDS[manager]}
          </code>
          <CopyButton text={COMMANDS[manager]} label="the command" />
        </div>
      </div>

      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
        That writes one entry into your client&apos;s configuration and nothing else. No private key
        is written anywhere, and the four tools appear the next time the client starts.
      </p>
    </Reveal>
  );
}
