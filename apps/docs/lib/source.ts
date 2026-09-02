/**
 * The loader that turns the MDX collection into pages with URLs.
 *
 * `baseUrl` is `/docs` rather than `/`, so the site keeps the same shape it had
 * before this rebuild and every link already published to it still resolves.
 */

import { loader } from "fumadocs-core/source";

import { docs } from "@/.source/server";

export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
});
