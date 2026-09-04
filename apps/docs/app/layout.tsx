import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";

import "./global.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "Tab Docs",
  description:
    "Post-paid billing and a credit facility for autonomous agents, verified on Creditcoin.",
  // Both, and in this order. Fumadocs' own head requests `/icon.svg`; naming the
  // files here is what stops every page logging a 404 for an icon that was never
  // going to exist.
  icons: {
    icon: [
      { url: "/icon.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon.ico", sizes: "any" },
    ],
  },
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
