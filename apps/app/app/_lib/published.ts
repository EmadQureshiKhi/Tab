/**
 * The published directory, compiled into the build.
 *
 * `service-endpoints.json` is this project's, committed at the repository root,
 * and it is the only source of where a registered Service can be called and of
 * what a Service says about x402 and the API Hub. It is imported rather than
 * read from disk at request time: the Dashboard is deployed from its own
 * directory, where a path two levels up is not part of what the host ships, and
 * an import makes the file part of the server bundle wherever that runs. The
 * cost is that a change to the file needs a rebuild, which a change to where a
 * Service lives should get anyway.
 *
 * Every entry names its chain, and a page is handed only the entries for the
 * network it renders, so a Testnet page never offers a Mainnet endpoint. The
 * narrowing lives in `catalogue.ts`, where it is tested without a bundler. A
 * malformed file is not an error worth failing a page for: every price on
 * either page is chain state and stands without it.
 */

import directory from "../../../../service-endpoints.json";

import { parsePublishedDirectory, publishedOn, type PublishedService } from "../../src/dashboard/catalogue";

const ALL: readonly PublishedService[] = parsePublishedDirectory(directory);

/** The published entries that serve one network. */
export function publishedDirectory(chainId: number): readonly PublishedService[] {
  return publishedOn(ALL, chainId);
}
