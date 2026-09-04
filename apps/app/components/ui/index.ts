/**
 * The Dashboard primitives.
 *
 * These are ours: they live in the tree, so their tokens, their markup, and
 * their accessibility behaviour are all editable here rather than pinned behind
 * a version number. Two rules hold across every file under this directory:
 *
 *   1. **Colour comes only from the theme tokens** in `styles/`. The Tailwind
 *      colour namespace is cleared and rebuilt from those tokens, so a colour a
 *      primitive can name is a colour `src/theme/check-contrast.ts` has measured.
 *   2. **The focus indicator is 2 px at a 2 px offset, on `:focus-visible` only,
 *      and nothing ever removes an outline.** `focus-ring.ts` holds the single
 *      definition and `test/ui.test.mjs` enforces both halves.
 *
 * Composites belong in `components/custom-ui`, and they build from here.
 *
 * Requirements: 24.8, 24.10
 */

export { cn, type ClassValue } from "./cn";
export { FOCUS_RING, FOCUS_RING_WITHIN } from "./focus-ring";
export { Slot, mergeSlotProps, type SlotProps } from "./slot";

export {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  ExternalLinkIcon,
  type IconProps,
} from "./icons";

export { Badge, badgeVariants, type BadgeProps } from "./badge";
export { Button, buttonVariants, type ButtonProps } from "./button";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  focusableWithin,
  type DialogCloseProps,
  type DialogContentProps,
  type DialogProps,
  type DialogTriggerProps,
} from "./dialog";
export { Input, inputVariants, type InputProps } from "./input";
export { Link, linkVariants, type LinkProps } from "./link";
export { Select, SelectGroup, SelectOption, selectVariants, type SelectProps } from "./select";
export { SkipLink, type SkipLinkProps } from "./skip-link";
export { Skeleton, type SkeletonProps } from "./skeleton";
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  type TableHeadProps,
  type TableProps,
} from "./table";
export {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  tabsListVariants,
  tabsTriggerVariants,
  type TabsContentProps,
  type TabsListProps,
  type TabsProps,
  type TabsTriggerProps,
} from "./tabs";
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  tooltipContentVariants,
  type TooltipContentProps,
  type TooltipProps,
  type TooltipProviderProps,
  type TooltipTriggerProps,
} from "./tooltip";
