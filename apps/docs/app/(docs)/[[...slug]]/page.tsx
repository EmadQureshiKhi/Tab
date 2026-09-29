import { notFound } from "next/navigation";
import { DocsBody, DocsPage, DocsTitle } from "fumadocs-ui/page";

import { CopyMarkdown } from "@/components/page-actions";
import { getMDXComponents } from "@/mdx-components";
import { source } from "@/lib/source";

export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly slug?: string[] }>;
}) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (page === undefined) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      {/*
        The title and the one action share a line, the action pushed to the far
        edge, so the first thing on the page is close to the heading.

        The frontmatter description is not drawn. It is the page's metadata
        description and its search result summary, and it restated the title on
        every page that had one.
      */}
      <div className="flex items-start justify-between gap-4">
        <DocsTitle className="mb-0">{page.data.title}</DocsTitle>
        <CopyMarkdown markdownUrl={`/llms.mdx/${(slug ?? []).join("/")}`} />
      </div>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly slug?: string[] }>;
}) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (page === undefined) notFound();
  return { title: page.data.title, description: page.data.description };
}
