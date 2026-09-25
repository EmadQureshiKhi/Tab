"use client";

/**
 * Copy this page as Markdown.
 *
 * A reader who wants to hand a page to a model, or keep it beside their own
 * notes, wants the source rather than the rendering. The control fetches the raw
 * Markdown from a route generated alongside the page, so what is copied is what
 * the page was written from.
 *
 * The fetched text is cached for the life of the tab, because a reader who copies
 * twice should not wait twice, and the file cannot change under them mid-session.
 */

import { useState } from "react";
import { Check, Copy } from "lucide-react";

const cache = new Map<string, string>();

export function CopyMarkdown({ markdownUrl }: { readonly markdownUrl: string }) {
  const [state, setState] = useState<"idle" | "loading" | "copied">("idle");

  const copy = () => {
    if (state === "loading") return;
    const cached = cache.get(markdownUrl);

    const write = (text: string) => {
      cache.set(markdownUrl, text);
      void navigator.clipboard
        ?.writeText(text)
        .then(() => {
          setState("copied");
          setTimeout(() => setState("idle"), 2000);
        })
        .catch(() => setState("idle"));
    };

    if (cached !== undefined) {
      write(cached);
      return;
    }

    setState("loading");
    void fetch(markdownUrl)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error("not found"))))
      .then(write)
      // A failed fetch leaves the control as it was rather than claiming a copy
      // that did not happen.
      .catch(() => setState("idle"));
  };

  return (
    <button
      type="button"
      onClick={copy}
      disabled={state === "loading"}
      aria-label={state === "copied" ? "Page copied as Markdown" : "Copy this page as Markdown"}
      className="inline-flex items-center gap-2 rounded-md border border-fd-border px-2.5 py-1.5 text-xs font-medium text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground disabled:opacity-60"
    >
      {state === "copied" ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      {state === "copied" ? "Copied" : state === "loading" ? "Copying" : "Copy as Markdown"}
    </button>
  );
}
