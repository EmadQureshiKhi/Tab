/**
 * The loader that turns the MDX collection into pages with URLs.
 *
 * `baseUrl` is `/`: the site is only documentation, so every page sits at the
 * root and the introduction is the landing page.
 */

import { loader } from "fumadocs-core/source";

import { docs } from "@/.source/server";

export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
});
