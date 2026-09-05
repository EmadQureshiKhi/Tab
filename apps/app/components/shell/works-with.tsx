"use client";

/**
 * The clients an Agent can already be reached through.
 *
 * It answers the question a reader has immediately after the setup command, which
 * is whether that command applies to the thing they actually use. Names rather
 * than marks alone: a row of grey glyphs is a puzzle, and the point is
 * recognition.
 *
 * The logos are greyed until hovered so the row reads as one texture rather than
 * as eight competing brands, which is how the reference draws it.
 */

import { RevealGroup, RevealItem } from "../motion/reveal";

/*
 * Eight clients, each with its own mark.
 *
 * Every file here carries real fills rather than `currentColor`. A mark drawn in
 * `currentColor` inherits nothing inside an `<img>`, so it resolves to black and
 * the greyscale treatment below leaves it invisible on a dark page, which is
 * exactly what happened to two of these before they were swapped out.
 */
const CLIENTS = [
  { name: "Claude", href: "https://claude.ai", icon: "/logos/clients/claude.svg" },
  { name: "Cursor", href: "https://cursor.com", icon: "/logos/clients/cursor-cube.svg" },
  { name: "OpenAI", href: "https://openai.com/codex", icon: "/logos/clients/OpenAI-black-monoblossom.svg" },
  { name: "OpenCode", href: "https://opencode.ai", icon: "/logos/clients/opencode.svg" },
  { name: "Gemini", href: "https://gemini.google.com", icon: "/logos/clients/Google_Gemini_icon_2025.svg" },
  { name: "Zed", href: "https://zed.dev", icon: "/logos/clients/zed-logo.svg" },
  { name: "Perplexity", href: "https://perplexity.ai", icon: "/logos/clients/perplexity.svg" },
  { name: "DeepSeek", href: "https://deepseek.com", icon: "/logos/clients/DeepSeek-icon.svg" },
] as const;

export function WorksWith() {
  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Works with
        </p>
        <h2 className="font-host text-2xl font-semibold text-foreground sm:text-3xl">
          Any client that speaks MCP
        </h2>
      </div>

      <RevealGroup className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4 lg:grid-cols-8">
        {CLIENTS.map((client) => (
          <RevealItem key={client.name}>
            <a
              href={client.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex flex-col items-center gap-3 no-underline"
            >
              <img
                src={client.icon}
                alt=""
                width={40}
                height={40}
                className="h-10 w-10 object-contain opacity-60 brightness-0 grayscale transition-opacity duration-200 group-hover:opacity-100 dark:brightness-200"
              />
              <span className="text-center text-[11px] font-medium tracking-[0.15em] text-muted-foreground uppercase transition-colors group-hover:text-foreground">
                {client.name}
              </span>
            </a>
          </RevealItem>
        ))}
      </RevealGroup>
    </section>
  );
}
