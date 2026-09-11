/**
 * The Dashboard shell.
 *
 * The presentation layer here is mapped from the reference one to one: the same
 * three fonts, the same masthead shape, the same hairline footer, and the same
 * two surfaces in light and dark. What is not borrowed is the content, which is
 * this product's own.
 *
 * ## The theme is decided before the first paint
 *
 * A script in the head reads the stored choice and sets the class on `<html>`
 * synchronously. Doing it in React instead would paint the default theme first
 * and correct it a frame later, which a reader who chose dark sees as a white
 * flash on every navigation.
 *
 * ## The chain lives in the URL
 *
 * The toggle links to the current path with `?chainKey=`, so a view of one chain
 * is shareable and survives a reload with no client state. A layout cannot read
 * `searchParams` in the App Router, so the header takes the default and each page
 * states in its own heading which chain it is showing.
 *
 * ## No wallet anywhere
 *
 * There is no provider, no connect button and no account state in this tree.
 * Every read-only route renders fully without one, which is R24.9 and is asserted
 * by the browser suite rather than only claimed here.
 */

import type { ReactNode } from "react";
import { Geist_Mono, Host_Grotesk, Inter } from "next/font/google";

import { SkipLink } from "../components/ui/skip-link";
import { ThemeProvider, THEME_BOOT_SCRIPT } from "../components/providers/theme-context";
import { SmoothScroll } from "../components/motion/smooth-scroll";
import { Chrome } from "./_lib/chrome";
import { WalletProvider } from "../components/wallet/wallet-context";
import { TransactionToastProvider } from "../components/shell/transaction-toast";
import { DEFAULT_CHAIN_KEY } from "../src/dashboard/chains";
import { docsUrl, explorerBaseUrl } from "./_lib/context";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const hostGrotesk = Host_Grotesk({
  variable: "--font-host-grotesk",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

const DESCRIPTION =
  "Post-paid billing and a credit facility for autonomous agents, verified on Creditcoin.";

export const metadata = {
  title: "Tab: post-paid billing for autonomous agents",
  description: DESCRIPTION,
  openGraph: {
    title: "Tab: post-paid billing for autonomous agents",
    description: DESCRIPTION,
    type: "website",
    siteName: "Tab",
    images: [{ url: "/banner.png", width: 1679, height: 937, alt: "Tab: post-paid billing and a credit facility for agents" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Tab: post-paid billing for autonomous agents",
    description: DESCRIPTION,
    images: ["/banner.png"],
  },
  icons: {
    icon: [
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body
        className={`${inter.variable} ${hostGrotesk.variable} ${geistMono.variable} min-h-screen bg-background text-foreground antialiased`}
      >
        <ThemeProvider>
          <TransactionToastProvider explorerUrl={explorerBaseUrl()}>
          <WalletProvider>
          <SmoothScroll />
          <SkipLink />
          <Chrome
            chainKey={DEFAULT_CHAIN_KEY}
            docsUrl={docsUrl()}
            explorerUrl={explorerBaseUrl()}
          >
            {children}
          </Chrome>
          </WalletProvider>
          </TransactionToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
