"use client";

/**
 * Light and dark, held in one place.
 *
 * The class goes on `<html>` rather than on a wrapper, because the page
 * background is painted by `html` and a wrapper would leave the area outside the
 * document flow in the other theme. The choice is written to `localStorage` under
 * one key and read back by a script in the document head before first paint, so
 * a reader who chose dark never sees a white flash on the way to it.
 *
 * `mounted` exists for one reason: the server cannot know the reader's choice, so
 * anything whose class depends on the theme must render neutral until the client
 * has read storage. Skipping that produces a hydration mismatch, and React's
 * recovery from one is a full client re-render of the tree.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export const THEME_STORAGE_KEY = "tab-theme";

interface ThemeState {
  readonly isDark: boolean;
  readonly mounted: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeState>({
  isDark: false,
  mounted: false,
  toggleTheme: () => undefined,
});

/**
 * Read once, before paint, by the inline script this pairs with.
 *
 * It also marks the document as scripted. Entrance animations are rendered by the
 * server with their hidden state already inline, so a reader whose script never
 * arrives would be left looking at an empty page. The `js` class is what the
 * stylesheet keys the fallback off, and it is added outside the `try` so a
 * storage failure cannot cost a reader the content.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{
var saved = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
var dark = saved === "dark" || (saved !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.classList.toggle("dark", dark);
document.documentElement.setAttribute("data-tab-theme", dark ? "dark" : "light");
}catch(e){}
document.documentElement.classList.add("js");})();`;

/**
 * Writes the choice to both selectors the stylesheets key off.
 *
 * There are two theme layers here and they were built to different conventions:
 * the generated token set switches on `[data-tab-theme]` and on the system
 * preference, and the presentation layer mapped from the reference switches on a
 * `.dark` class. Setting only one left the page background dark and every card on
 * it light, which is what happened before this function existed. One writer, both
 * attributes, so the two can never disagree.
 */
function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.setAttribute("data-tab-theme", dark ? "dark" : "light");
}

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [isDark, setIsDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const dark = document.documentElement.classList.contains("dark");
    // The boot script sets both, but a page served from a cache that predates it
    // may carry only the class, so the pair is reconciled once on mount.
    applyTheme(dark);
    setIsDark(dark);
    setMounted(true);
  }, []);

  const toggleTheme = useCallback(() => {
    setIsDark((current) => {
      const next = !current;
      applyTheme(next);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next ? "dark" : "light");
      } catch {
        // A reader with storage blocked still gets the toggle for this page. The
        // choice simply does not survive a reload, which is better than refusing
        // to switch at all.
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ isDark, mounted, toggleTheme }), [isDark, mounted, toggleTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
