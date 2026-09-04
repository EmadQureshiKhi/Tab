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
        The title and the one action on the row share a line, the action pushed to
        the far edge. It sat under the title before, on its own row above a rule,
        which spent three bands of vertical space - subtitle, action, rule - between
        the heading and the first thing on the page worth looking at.

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
