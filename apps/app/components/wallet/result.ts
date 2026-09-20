/**
 * The `Result` this folder returns, kept local on purpose.
 *
 * `@tabai/shared` has a richer one carrying a `TabError` with a category and a
 * remedy, and it is the right type for anything that crosses a service boundary.
 * A wallet failure crosses no boundary: it is read once, by the component that
 * asked, and rendered as a sentence. Reaching for the shared type here would put
 * a taxonomy around a string nobody branches on.
 */

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T>(message: string): Result<T> => ({ ok: false, message });
