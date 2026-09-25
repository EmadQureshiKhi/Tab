import defaultComponents from "fumadocs-ui/mdx";

import { Bounded, Card, Cards, Stat, Stats, Step, Steps } from "./components/blocks";

/**
 * The components MDX renders into.
 *
 * Fumadocs' defaults, plus the few shapes this material keeps needing that plain
 * Markdown has no element for: a set of routes to send a reader to, a figure with
 * the sentence that makes it mean something, a numbered sequence, and a boundary
 * stated with its bound. Nothing here overrides a default, so every ordinary
 * element still renders the way the rest of the site renders it.
 */
export function getMDXComponents(components?: Record<string, unknown>) {
  return { ...defaultComponents, Cards, Card, Stats, Stat, Steps, Step, Bounded, ...components };
}
