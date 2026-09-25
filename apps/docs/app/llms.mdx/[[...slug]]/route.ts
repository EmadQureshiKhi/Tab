/**
 * The raw Markdown of one page.
 *
 * The copy control on every page fetches this rather than scraping the rendered
 * DOM, so what lands on the clipboard is the source a reader can paste into a
 * model or a file, headings and code fences intact.
 *
 * It is generated statically alongside the pages themselves, so it costs nothing
 * to serve and cannot drift from what the page shows.
 */

import { notFound } from "next/navigation";

import { source } from "@/lib/source";

export const revalidate = false;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (page === undefined) notFound();

  const content = await page.data.getText("raw");
  return new Response(`# ${page.data.title}\n\n${content}`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

export function generateStaticParams() {
  return source.generateParams();
}
