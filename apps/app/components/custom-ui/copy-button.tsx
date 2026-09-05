"use client";

/**
 * Copy, with the result shown on the control that did it.
 *
 * The catalogue and the setup section both hand a reader something to paste, and
 * a copy control that says nothing after a press leaves them pressing it again.
 * The tick replaces the glyph for two seconds, which is long enough to be seen
 * and short enough that the control is ready again before it is wanted.
 *
 * A refused copy is silent by design. `navigator.clipboard` is absent on an
 * insecure origin and can be refused by permission, and a control that claimed a
 * copy which did not happen would be worse than one that appeared not to react:
 * the reader would paste nothing and not know why.
 */

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "../ui/cn";
import { FOCUS_RING } from "../ui/focus-ring";

export function CopyButton({
  text,
  label,
  className,
}: {
  readonly text: string;
  /** Named in the accessible label, so a screen reader is told what was copied. */
  readonly label: string;
  readonly className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className={cn(
        "shrink-0 rounded-md p-1.5 transition-colors hover:bg-foreground/10",
        FOCUS_RING,
        className,
      )}
    >
      {copied ? (
        <Check className="h-4 w-4 text-teal-600 dark:text-teal-300" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      )}
    </button>
  );
}
