/**
 * PostCSS wiring for the Tailwind v4 theme.
 *
 * Tailwind v4 ships its whole pipeline as one PostCSS plugin, and the theme
 * itself lives in `styles/theme.css`, so this file carries no token
 * configuration and never will.
 *
 * Requirements: 24.8
 */

/** @type {{ plugins: Record<string, Record<string, never>> }} */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
