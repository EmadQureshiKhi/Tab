/**
 * Class-name composition for the Dashboard primitives.
 *
 * Every primitive builds its classes the same way: a `cva` recipe for the
 * variants, then `cn` to fold in whatever the call site passes. `cn` resolves
 * Tailwind conflicts last-wins, so a consumer can override a primitive's
 * padding or colour without fighting specificity.
 *
 * Requirements: 24.8, 24.10
 */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export type { ClassValue };

/** Composes conditional class names and resolves Tailwind conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
