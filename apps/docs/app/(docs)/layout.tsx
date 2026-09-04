import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";

import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

/** Where the Dashboard lives, so the masthead can link back to it. */
function appUrl(): string {
  return process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
}

export default function Layout({ children }: { readonly children: ReactNode }) {
  return (
    <DocsLayout tree={source.pageTree} {...baseOptions(appUrl())}>
      {children}
    </DocsLayout>
  );
}
