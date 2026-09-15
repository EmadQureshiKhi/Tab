/**
 * The Dashboard shell.
 *
 * Three fonts, a masthead, a hairline footer and two surfaces in light and dark,
 * declared once here and in `styles/presentation.css` so every route shares
 * them.
 *
 * ## The theme is decided before the first paint
 *
 * A script in the head reads the stored choice and sets the class on `<html>`
 * synchronously. Doing it in React instead would paint the default theme first
 * and correct it a frame later, which a reader who chose dark sees as a white
 * flash on every navigation.
 *
 * ## The network is a deployment constant
 *
 * One Monad chain per deployment, resolved once here from the environment and
 * shown on the masthead. There is no toggle and nothing in the URL, because a
 * Settlement on this chain could not have come from any other.
 *
 * ## No wallet anywhere on a read
 *
 * Every read-only route renders fully without a wallet, which the browser suite
 * asserts rather than this comment only claiming it. The provider in this tree
 * connects nothing on its own; it exists for the four routes that sign
 * (`/authorise`, `/services/new`, `/services/bond` and `/keys`), and it prompts
 * only after a press.
 */

import type { ReactNode } from "react";
import { Geist_Mono, Host_Grotesk, Inter } from "next/font/google";

import { SkipLink } from "../components/ui/skip-link";
import { ThemeProvider, THEME_BOOT_SCRIPT } from "../components/providers/theme-context";
import { SmoothScroll } from "../components/motion/smooth-scroll";
import { Chrome } from "./_lib/chrome";
import { WalletProvider } from "../components/wallet/wallet-context";
import { TransactionToastProvider } from "../components/shell/transaction-toast";
import { docsUrl, explorerBaseUrl, network } from "./_lib/context";
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

const TITLE = "Tab - post-paid billing for agents on Monad";

/**
 * Where this Dashboard is served from, so the social card resolves to an
 * absolute URL. A relative image path in Open Graph metadata is ignored by
 * every crawler, and Next warns on every build until the base is named.
 */
function metadataBase(): URL {
  const configured = process.env["NEXT_PUBLIC_APP_URL"]?.trim();
  try {
    return new URL(configured !== undefined && configured.length > 0 ? configured : "http://localhost:3000");
  } catch {
    return new URL("http://localhost:3000");
  }
}
const DESCRIPTION =
  "Post-paid billing and a credit facility for autonomous agents. A Service meters usage into an Open Tab, the Agent settles in stablecoin with its own key, and the payment and the ledger entry land in one Monad transaction.";

export const metadata = {
  metadataBase: metadataBase(),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    siteName: "Tab",
    images: [
      {
        url: "/banner.png",
        width: 1679,
        height: 937,
        alt: "Tab: post-paid billing and a credit facility for agents on Monad",
      },
    ],
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
  const chain = network();
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
                docsUrl={docsUrl()}
                explorerUrl={explorerBaseUrl()}
                networkName={chain.name}
                networkKind={chain.network}
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
