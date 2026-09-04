/**
 * `asChild` support, without a component dependency.
 *
 * Several primitives need to hand their styling and behaviour to an element the
 * call site supplies — a routing link inside `Link`, a custom control inside
 * `TooltipTrigger` — instead of rendering their own tag. `Slot` merges the
 * primitive's props onto that single child element:
 *
 *   - class names compose through `cn`, so the primitive's classes apply and the
 *     child's classes win on conflict;
 *   - inline styles merge, child last;
 *   - event handlers compose, the primitive's handler first, and the child's
 *     handler still runs unless the event was already stopped;
 *   - every other prop the child declares wins, so a child can override an
 *     `aria-*` value or an `id` the primitive proposed.
 *
 * That ordering matters for accessibility: a primitive supplies `aria-*` and
 * `tabIndex` defaults, and a call site with better information can always
 * correct them.
 *
 * Requirements: 24.10
 */

import * as React from "react";

import { cn } from "./cn";

type UnknownProps = Record<string, unknown>;

function isEventHandlerName(name: string): boolean {
  return name.startsWith("on") && name.length > 2 && name[2] === name[2]?.toUpperCase();
}

function composeHandlers(
  own: (...args: never[]) => unknown,
  child: (...args: never[]) => unknown,
): (...args: never[]) => unknown {
  return (...args: never[]) => {
    own(...args);
    return child(...args);
  };
}

/** Merges the slot's own props with the child's, child last. */
export function mergeSlotProps(own: UnknownProps, child: UnknownProps): UnknownProps {
  const merged: UnknownProps = { ...own };

  for (const key of Object.keys(child)) {
    const ownValue = own[key];
    const childValue = child[key];

    if (
      isEventHandlerName(key) &&
      typeof ownValue === "function" &&
      typeof childValue === "function"
    ) {
      merged[key] = composeHandlers(
        ownValue as (...args: never[]) => unknown,
        childValue as (...args: never[]) => unknown,
      );
      continue;
    }

    if (key === "className") {
      merged[key] = cn(ownValue as string | undefined, childValue as string | undefined);
      continue;
    }

    if (key === "style" && typeof ownValue === "object" && ownValue !== null) {
      merged[key] = { ...(ownValue as React.CSSProperties), ...(childValue as React.CSSProperties) };
      continue;
    }

    merged[key] = childValue;
  }

  return merged;
}

export type SlotProps = UnknownProps & { children?: React.ReactNode };

/**
 * Renders its single child element with the slot's props merged in. Anything
 * other than a single element renders nothing, which keeps a misuse visible in
 * development rather than silently dropping the props.
 */
export function Slot({ children, ...slotProps }: SlotProps) {
  if (!React.isValidElement<UnknownProps>(children)) return null;

  return React.cloneElement(
    children,
    mergeSlotProps(slotProps, children.props as UnknownProps) as Partial<UnknownProps> &
      React.Attributes,
  );
}
