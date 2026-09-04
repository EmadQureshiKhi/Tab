"use client";

/**
 * Tabs.
 *
 * The ARIA tabs pattern in full, because a half-implemented tab list is worse
 * than a set of links:
 *
 *   - the list is a `tablist`, each trigger a `tab`, each panel a `tabpanel`;
 *   - one roving tab stop: the selected trigger is the only one with
 *     `tabIndex={0}`, so Tab enters the list once and moves on rather than
 *     walking every trigger (SC 2.1.1);
 *   - Left and Right move between triggers and wrap, Home and End jump to the
 *     ends, and selection follows focus, which is the expected behaviour when
 *     panels are cheap to render;
 *   - each trigger points at its panel with `aria-controls`, each panel names its
 *     trigger with `aria-labelledby`, and the panel is focusable so Tab out of
 *     the trigger lands in the content it just revealed (SC 2.4.3, SC 4.1.2);
 *   - the inactive panel is unmounted rather than hidden, so nothing offscreen
 *     stays in the accessibility tree.
 *
 * Selection is carried by text and by the fill, and the fill is the accent token
 * with badge ink on it, so an active tab is not signalled by colour alone
 * (SC 1.4.1).
 *
 * Requirements: 24.10
 */

import * as React from "react";
import { type VariantProps, cva } from "class-variance-authority";

import { cn } from "./cn";
import { FOCUS_RING } from "./focus-ring";

interface TabsContextValue {
  readonly value: string;
  readonly setValue: (value: string) => void;
  readonly idBase: string;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(part: string): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (context === null) {
    throw new Error(`<${part}> must be rendered inside <Tabs>`);
  }
  return context;
}

function triggerId(idBase: string, value: string): string {
  return `${idBase}-trigger-${value}`;
}

function panelId(idBase: string, value: string): string {
  return `${idBase}-panel-${value}`;
}

export type TabsProps = Omit<React.ComponentProps<"div">, "onChange"> & {
  /** Controlled selected value. */
  value?: string;
  /** Initially selected value when uncontrolled. */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

function Tabs({
  className,
  value: valueProp,
  defaultValue = "",
  onValueChange,
  ...props
}: TabsProps) {
  const [internalValue, setInternalValue] = React.useState(defaultValue);
  const isControlled = valueProp !== undefined;
  const value = isControlled ? valueProp : internalValue;
  const idBase = React.useId();

  const setValue = React.useCallback(
    (next: string) => {
      if (!isControlled) setInternalValue(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const context = React.useMemo<TabsContextValue>(
    () => ({ value, setValue, idBase }),
    [value, setValue, idBase],
  );

  return (
    <TabsContext.Provider value={context}>
      <div data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />
    </TabsContext.Provider>
  );
}

const tabsListVariants = cva(
  "inline-flex items-center justify-center gap-1 rounded-[2px] bg-card font-mono text-muted-foreground",
  {
    variants: {
      size: {
        default: "h-9 p-[3px]",
        tall: "h-14 p-2",
      },
      width: {
        fit: "w-fit",
        full: "w-full",
      },
    },
    defaultVariants: {
      size: "default",
      width: "fit",
    },
  },
);

export type TabsListProps = React.ComponentProps<"div"> & VariantProps<typeof tabsListVariants>;

function TabsList({ className, size, width, onKeyDown, ...props }: TabsListProps) {
  const listRef = React.useRef<HTMLDivElement>(null);

  return (
    <div
      ref={listRef}
      data-slot="tabs-list"
      role="tablist"
      className={cn(tabsListVariants({ size, width }), className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;

        const list = listRef.current;
        if (list === null) return;

        const triggers = Array.from(
          list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
        );
        if (triggers.length === 0) return;

        const current = triggers.findIndex(
          (trigger) => trigger === list.ownerDocument.activeElement,
        );
        if (current === -1) return;

        let next: number | null = null;
        if (event.key === "ArrowRight") next = (current + 1) % triggers.length;
        if (event.key === "ArrowLeft") next = (current - 1 + triggers.length) % triggers.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = triggers.length - 1;
        if (next === null) return;

        const target = triggers[next];
        if (target === undefined) return;
        event.preventDefault();
        target.focus();
        target.click();
      }}
      {...props}
    />
  );
}

const tabsTriggerVariants = cva(
  cn(
    "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[2px]",
    "border border-transparent px-3 py-1 font-mono text-sm font-medium whitespace-nowrap",
    "transition-[background-color,color] duration-[var(--tab-motion-fast)]",
    "hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
    "data-[state=active]:cursor-default",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    FOCUS_RING,
  ),
  {
    variants: {
      variant: {
        default:
          "text-muted-foreground data-[state=active]:bg-accent data-[state=active]:text-badge-ink",
        subtle:
          "text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:border-border",
      },
      width: {
        fit: "",
        equal: "flex-1",
      },
    },
    defaultVariants: {
      variant: "default",
      width: "fit",
    },
  },
);

export type TabsTriggerProps = React.ComponentProps<"button"> &
  VariantProps<typeof tabsTriggerVariants> & {
    /** The value this trigger selects. */
    value: string;
  };

function TabsTrigger({
  className,
  variant,
  width,
  value,
  onClick,
  type,
  ...props
}: TabsTriggerProps) {
  const context = useTabsContext("TabsTrigger");
  const active = context.value === value;

  return (
    <button
      data-slot="tabs-trigger"
      type={type ?? "button"}
      role="tab"
      id={triggerId(context.idBase, value)}
      aria-selected={active}
      aria-controls={panelId(context.idBase, value)}
      tabIndex={active ? 0 : -1}
      data-state={active ? "active" : "inactive"}
      className={cn(tabsTriggerVariants({ variant, width }), className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) context.setValue(value);
      }}
      {...props}
    />
  );
}

export type TabsContentProps = React.ComponentProps<"div"> & {
  /** The value that reveals this panel. */
  value: string;
};

function TabsContent({ className, value, ...props }: TabsContentProps) {
  const context = useTabsContext("TabsContent");
  if (context.value !== value) return null;

  return (
    <div
      data-slot="tabs-content"
      role="tabpanel"
      id={panelId(context.idBase, value)}
      aria-labelledby={triggerId(context.idBase, value)}
      tabIndex={0}
      className={cn("flex-1 rounded-[2px] text-foreground", FOCUS_RING, className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants, tabsTriggerVariants };
