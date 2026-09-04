"use client";

/**
 * Dialog, with a real focus trap and real focus restore.
 *
 * The modal behaviour is implemented here rather than delegated, because the
 * four things SC 2.4.3 and SC 4.1.2 actually require of a modal are all things a
 * page can get subtly wrong:
 *
 *   1. **Focus moves in.** On open, focus lands on the first focusable control
 *      inside the panel, or on the panel itself when it holds none. `initialFocus`
 *      overrides that where a specific field should receive it.
 *   2. **Focus stays in.** Tab from the last control wraps to the first, and
 *      Shift+Tab from the first wraps to the last. The trap is computed on each
 *      keystroke rather than cached, so controls that appear while the dialog is
 *      open are included.
 *   3. **The background is out.** Every body child that does not contain the
 *      panel is marked `inert` while the dialog is open, which removes it from
 *      the tab order *and* from the accessibility tree, so a screen reader's
 *      virtual cursor cannot wander behind the dialog either. The previous
 *      value is restored on close, so nested dialogs unwind correctly.
 *   4. **Focus returns.** The element that was focused when the dialog opened is
 *      focused again on close, after the background is released — restoring
 *      focus first would be a no-op while the invoker is still inert. If that
 *      element has left the document, focus is left alone rather than thrown to
 *      the body arbitrarily.
 *
 * Escape closes, and a press on the scrim closes, unless `dismissible={false}` —
 * which is for a dialog whose action must be resolved, and which still keeps
 * Escape available through an explicit close control.
 *
 * The panel is named by its `DialogTitle` and described by its
 * `DialogDescription` through ids the root generates, so the name and the
 * description are wired without the call site plumbing them.
 *
 * Requirements: 24.10
 */

import * as React from "react";

import { cn } from "./cn";
import { FOCUS_RING } from "./focus-ring";
import { CloseIcon } from "./icons";

/**
 * Everything that can hold focus by default, excluding anything already removed
 * from the tab order with `tabindex="-1"` and anything disabled.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "details > summary:first-of-type",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
]
  .map((selector) => `${selector}:not([tabindex='-1']):not([aria-hidden='true'])`)
  .join(",");

function isRendered(element: HTMLElement): boolean {
  if (element.hasAttribute("disabled")) return false;
  if (element.closest("[inert]") !== null) return false;
  return element.getClientRects().length > 0 || element.offsetWidth > 0 || element.offsetHeight > 0;
}

/** The tabbable descendants of `root`, in document order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isRendered);
}

/**
 * Marks everything outside `content` inert and locks page scrolling. Returns the
 * function that puts both back exactly as they were.
 */
function holdBackground(content: HTMLElement): () => void {
  const body = content.ownerDocument.body;
  const undo: (() => void)[] = [];

  for (const child of Array.from(body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.contains(content)) continue;
    const wasInert = child.inert;
    child.inert = true;
    undo.push(() => {
      child.inert = wasInert;
    });
  }

  const previousOverflow = body.style.overflow;
  body.style.overflow = "hidden";
  undo.push(() => {
    body.style.overflow = previousOverflow;
  });

  return () => {
    for (const step of undo.reverse()) step();
  };
}

/** Keeps Tab and Shift+Tab inside `container`. */
function trapTab(event: React.KeyboardEvent<HTMLElement>, container: HTMLElement): void {
  const items = focusableWithin(container);
  const first = items[0];
  const last = items[items.length - 1];

  if (first === undefined || last === undefined) {
    event.preventDefault();
    container.focus();
    return;
  }

  const active = container.ownerDocument.activeElement;
  const outside = active === null || !container.contains(active);

  if (event.shiftKey) {
    if (active === first || active === container || outside) {
      event.preventDefault();
      last.focus();
    }
    return;
  }

  if (active === last || active === container || outside) {
    event.preventDefault();
    first.focus();
  }
}

interface DialogContextValue {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly titleId: string;
  readonly descriptionId: string;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialogContext(part: string): DialogContextValue {
  const context = React.useContext(DialogContext);
  if (context === null) {
    throw new Error(`<${part}> must be rendered inside <Dialog>`);
  }
  return context;
}

export type DialogProps = {
  /** Controlled open state. Omit for an uncontrolled dialog. */
  open?: boolean;
  /** Initial open state when uncontrolled. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
};

function Dialog({ open: openProp, defaultOpen = false, onOpenChange, children }: DialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const idBase = React.useId();
  const value = React.useMemo<DialogContextValue>(
    () => ({
      open,
      setOpen,
      titleId: `${idBase}-title`,
      descriptionId: `${idBase}-description`,
    }),
    [open, setOpen, idBase],
  );

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

export type DialogTriggerProps = React.ComponentProps<"button">;

function DialogTrigger({ onClick, type, ...props }: DialogTriggerProps) {
  const { setOpen } = useDialogContext("DialogTrigger");

  return (
    <button
      data-slot="dialog-trigger"
      type={type ?? "button"}
      aria-haspopup="dialog"
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setOpen(true);
      }}
      {...props}
    />
  );
}

export type DialogContentProps = Omit<React.ComponentProps<"div">, "role"> & {
  /** Escape and a press on the scrim close the dialog. */
  dismissible?: boolean;
  /** Renders the corner close control. */
  showCloseButton?: boolean;
  /** Receives focus on open instead of the first focusable control. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  /** Overrides the generated description id, for a dialog with no description. */
  describedBy?: string | undefined;
};

/**
 * The open dialog. It exists only while the dialog is open, so mounting is
 * opening and unmounting is closing — which is what lets one effect own the
 * whole modal lifecycle: capture the invoker, hold the background, move focus
 * in, then release the background and return focus on the way out.
 */
function DialogPanel({
  className,
  children,
  dismissible = true,
  showCloseButton = true,
  initialFocus,
  describedBy,
  onKeyDown,
  ...props
}: DialogContentProps) {
  const { setOpen, titleId, descriptionId } = useDialogContext("DialogContent");
  const panelRef = React.useRef<HTMLDivElement>(null);
  const invokerRef = React.useRef<HTMLElement | null>(null);
  const initialFocusRef = React.useRef(initialFocus);
  initialFocusRef.current = initialFocus;

  React.useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;

    const active = panel.ownerDocument.activeElement;
    invokerRef.current = active instanceof HTMLElement ? active : null;

    const release = holdBackground(panel);

    const target = initialFocusRef.current?.current ?? focusableWithin(panel)[0] ?? panel;
    target.focus();

    return () => {
      release();
      const invoker = invokerRef.current;
      if (invoker !== null && invoker.isConnected) invoker.focus();
    };
  }, []);

  return (
    <div
      data-slot="dialog-scrim"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        ref={panelRef}
        data-slot="dialog-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy === undefined ? descriptionId : describedBy}
        tabIndex={-1}
        className={cn(
          "raised-panel relative grid w-full max-w-lg gap-4 rounded-[2px] p-6 shadow-lg",
          "text-foreground",
          FOCUS_RING,
          className,
        )}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === "Escape" && dismissible) {
            event.preventDefault();
            setOpen(false);
            return;
          }
          if (event.key === "Tab" && panelRef.current !== null) {
            trapTab(event, panelRef.current);
          }
        }}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogClose
            className={cn(
              "absolute top-4 right-4 inline-flex size-8 items-center justify-center rounded-[2px]",
              "text-muted-foreground hover:bg-background hover:text-foreground",
              "transition-colors duration-[var(--tab-motion-fast)]",
            )}
          >
            <CloseIcon />
            <span className="sr-only">Close</span>
          </DialogClose>
        ) : null}
      </div>
    </div>
  );
}

function DialogContent(props: DialogContentProps) {
  const { open } = useDialogContext("DialogContent");
  if (!open) return null;
  return <DialogPanel {...props} />;
}

export type DialogCloseProps = React.ComponentProps<"button">;

function DialogClose({ className, onClick, type, ...props }: DialogCloseProps) {
  const { setOpen } = useDialogContext("DialogClose");

  return (
    <button
      data-slot="dialog-close"
      type={type ?? "button"}
      className={cn(FOCUS_RING, className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setOpen(false);
      }}
      {...props}
    />
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 pr-8", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, id, ...props }: React.ComponentProps<"h2">) {
  const { titleId } = useDialogContext("DialogTitle");

  return (
    <h2
      data-slot="dialog-title"
      id={id ?? titleId}
      className={cn("font-mono text-lg leading-none font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, id, ...props }: React.ComponentProps<"p">) {
  const { descriptionId } = useDialogContext("DialogDescription");

  return (
    <p
      data-slot="dialog-description"
      id={id ?? descriptionId}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
