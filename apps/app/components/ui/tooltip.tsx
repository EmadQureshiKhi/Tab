"use client";

/**
 * Tooltip.
 *
 * A tooltip that only answers to the mouse is not a tooltip, so this one is
 * driven by focus as well as hover, and it obeys the three rules SC 1.4.13 sets
 * for content that appears on hover or focus:
 *
 *   - **dismissable** — Escape closes it without moving focus;
 *   - **hoverable** — the content sits inside the same wrapper as the trigger and
 *     stays open while the pointer is over either, so a pointer can travel into
 *     it;
 *   - **persistent** — it stays until focus leaves, the pointer leaves, or
 *     Escape, and never on a timer.
 *
 * The content is the trigger's `aria-describedby` target and stays in the DOM
 * while hidden, so the description resolves for assistive technology whether or
 * not the tooltip is currently drawn. That means a tooltip is only ever
 * supplementary: never put the only copy of something a user needs in here.
 *
 * `TooltipProvider` exists so a subtree can share one `delayDuration`. There is
 * no shared open-state coordination in it, which is the one behaviour a floating
 * tooltip library would add.
 *
 * Requirements: 24.10
 */

import * as React from "react";
import { type VariantProps, cva } from "class-variance-authority";

import { cn } from "./cn";
import { FOCUS_RING } from "./focus-ring";
import { Slot } from "./slot";

interface TooltipContextValue {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly contentId: string;
  readonly delayDuration: number;
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null);
const TooltipDelayContext = React.createContext<number>(0);

function useTooltipContext(part: string): TooltipContextValue {
  const context = React.useContext(TooltipContext);
  if (context === null) {
    throw new Error(`<${part}> must be rendered inside <Tooltip>`);
  }
  return context;
}

export type TooltipProviderProps = {
  /** Milliseconds before a hovered tooltip opens. Focus always opens at once. */
  delayDuration?: number;
  children?: React.ReactNode;
};

function TooltipProvider({ delayDuration = 0, children }: TooltipProviderProps) {
  return (
    <TooltipDelayContext.Provider value={delayDuration}>{children}</TooltipDelayContext.Provider>
  );
}

export type TooltipProps = React.ComponentProps<"span"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
};

function Tooltip({
  className,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  delayDuration,
  ...props
}: TooltipProps) {
  const inheritedDelay = React.useContext(TooltipDelayContext);
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;
  const contentId = `${React.useId()}-tooltip`;

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const context = React.useMemo<TooltipContextValue>(
    () => ({ open, setOpen, contentId, delayDuration: delayDuration ?? inheritedDelay }),
    [open, setOpen, contentId, delayDuration, inheritedDelay],
  );

  return (
    <TooltipContext.Provider value={context}>
      <span
        data-slot="tooltip"
        className={cn("relative inline-flex", className)}
        onPointerLeave={() => setOpen(false)}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        {...props}
      />
    </TooltipContext.Provider>
  );
}

export type TooltipTriggerProps = React.ComponentProps<"button"> & {
  /** Render the child element instead of a `<button>`, keeping these props. */
  asChild?: boolean;
};

function TooltipTrigger({
  className,
  asChild = false,
  type,
  children,
  onPointerEnter,
  onFocus,
  ...props
}: TooltipTriggerProps) {
  const { open, setOpen, contentId, delayDuration } = useTooltipContext("TooltipTrigger");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const shared = {
    "data-slot": "tooltip-trigger",
    "aria-describedby": contentId,
    "data-state": open ? "open" : "closed",
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      onPointerEnter?.(event as React.PointerEvent<HTMLButtonElement>);
      if (delayDuration === 0) {
        setOpen(true);
        return;
      }
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setOpen(true), delayDuration);
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      onFocus?.(event as React.FocusEvent<HTMLButtonElement>);
      setOpen(true);
    },
  };

  if (asChild) {
    return (
      <Slot {...shared} className={className} {...props}>
        {children}
      </Slot>
    );
  }

  return (
    <button
      type={type ?? "button"}
      className={cn("inline-flex items-center gap-1 rounded-[2px]", FOCUS_RING, className)}
      {...shared}
      {...props}
    >
      {children}
    </button>
  );
}

const tooltipContentVariants = cva(
  cn(
    "raised-panel absolute z-50 w-max max-w-64 rounded-[2px] px-3 py-1.5",
    "text-xs text-balance text-foreground shadow-md",
  ),
  {
    variants: {
      side: {
        top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
        bottom: "top-full left-1/2 mt-2 -translate-x-1/2",
        left: "top-1/2 right-full mr-2 -translate-y-1/2",
        right: "top-1/2 left-full ml-2 -translate-y-1/2",
      },
    },
    defaultVariants: {
      side: "top",
    },
  },
);

export type TooltipContentProps = React.ComponentProps<"span"> &
  VariantProps<typeof tooltipContentVariants>;

function TooltipContent({ className, side, children, ...props }: TooltipContentProps) {
  const { open, contentId } = useTooltipContext("TooltipContent");

  return (
    <span
      data-slot="tooltip-content"
      id={contentId}
      role="tooltip"
      hidden={!open}
      data-state={open ? "open" : "closed"}
      className={cn(tooltipContentVariants({ side }), className)}
      {...props}
    >
      {children}
    </span>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, tooltipContentVariants };
