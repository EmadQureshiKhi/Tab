/**
 * The MCP server: the protocol wiring, and nothing else.
 *
 * Every decision about what a tool does lives in `toolset.ts`. This file turns
 * that into an MCP server -- it answers `tools/list` with the declarations from
 * `schemas.ts` verbatim, routes `tools/call` to the toolset, and speaks over one
 * of two transports.
 *
 * ## Two transports, one default
 *
 * stdio is the default because it is what an MCP client launches: the client
 * spawns `npx -y @tabai/sdk mcp`, talks over the pipe, and there is no port to
 * choose, no address to bind, and nothing listening when the client is closed.
 * Streamable HTTP is the other supported transport and is chosen by configuring
 * a port, for the case the client is not the thing that launches the server -- a
 * shared deployment, or a client on another machine.
 *
 * Two rules follow from stdio being the default and neither is optional:
 *
 * - **stdout carries protocol frames and nothing else.** One stray `console.log`
 *   corrupts the stream and the client drops the connection. Every log line this
 *   server writes goes to stderr, which is why {@link stderrLogger} exists
 *   rather than the package's `consoleLogger`.
 * - **A handler never throws.** The toolset returns a schema-valid payload on
 *   every path, and the one `catch` here is a backstop for a bug in this file,
 *   reported as a failed tool call rather than as a dropped transport.
 *
 * ## Results carry both forms
 *
 * Each call answers with `structuredContent` -- the payload, validated against
 * the tool's declared output schema -- and a `content` block holding the same
 * payload as pretty JSON, because a client that predates structured output would
 * otherwise see an empty result. `isError` is set when the payload reports a
 * failure, so a model does not read an empty list as "nothing is registered".
 *
 * Requirements: 25.1, 25.2, 25.3
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Result } from "@tabai/shared";
import { ok } from "@tabai/shared";

import { fail } from "../errors.js";
import type { Logger } from "../logger.js";
import { validateJsonValue } from "./json-schema.js";
import { field, isRecord } from "./json.js";
import { TAB_TOOLS, tabToolByName } from "./schemas.js";
import { resolveTabMcpSettings, type TabMcpSettings, type TabMcpSettingsOptions } from "./settings.js";
import type { RegistryFetch } from "./registry-client.js";
import { createTabToolset, type TabToolset } from "./toolset.js";

/** The name and version this server reports to a client. */
export const TAB_MCP_SERVER_INFO = { name: "tab", version: "0.1.0" } as const;

/**
 * A logger that writes to stderr.
 *
 * The package default writes `info` and `debug` to stdout, which on the stdio
 * transport is the protocol stream. This is the same interface with every level
 * pointed at stderr, so a server can be logged without being corrupted.
 */
export const stderrLogger: Logger = {
  debug: (message, fields) => write("debug", message, fields),
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
};

function write(level: string, message: string, fields?: Record<string, unknown>): void {
  const suffix = fields === undefined ? "" : ` ${safeJson(fields)}`;
  process.stderr.write(`tab-mcp ${level}: ${message}${suffix}\n`);
}

/** `JSON.stringify` that survives a `bigint` and a cycle, because a log line must not throw. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? `${entry.toString(10)}n` : entry)) ?? "";
  } catch {
    return "[unserialisable]";
  }
}

export interface TabMcpServerOptions extends TabMcpSettingsOptions {
  /** Pre-resolved settings. Skips config and environment discovery entirely. */
  readonly settings?: TabMcpSettings;
  /** A toolset to route calls to. Built from the settings when absent. */
  readonly toolset?: TabToolset;
  /** Passed through to the toolset it builds. See `TabToolsetOptions`. */
  readonly registryFetch?: RegistryFetch;
  readonly logger?: Logger;
}

/** A built server, with the pieces a caller may want to reach past the protocol. */
export interface TabMcpServer {
  readonly server: Server;
  readonly toolset: TabToolset;
  readonly settings: TabMcpSettings;
  /** Serves on stdio until the client closes the pipe. */
  serveStdio(): Promise<Result<void>>;
  /** Serves streamable HTTP on `port`, and answers with the address it bound. */
  serveHttp(options: ServeHttpOptions): Promise<Result<ServingHttp>>;
}

export interface ServeHttpOptions {
  readonly port: number;
  /** Defaults to `127.0.0.1`: a loopback bind, because this surface has no authentication. */
  readonly host?: string;
  /** Defaults to `/mcp`. */
  readonly endpoint?: string;
}

export interface ServingHttp {
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  close(): Promise<void>;
}

/**
 * Builds the server.
 *
 * Resolving settings is asynchronous because `tab.config` discovery is, which is
 * why this is a `Promise` rather than the total constructor the rest of the
 * package uses. It still cannot fail: a missing setting is reported by the tool
 * that needs it.
 */
export async function createTabMcpServer(options: TabMcpServerOptions = {}): Promise<TabMcpServer> {
  const logger = options.logger ?? stderrLogger;
  const settings = options.settings ?? (await resolveTabMcpSettings({ ...options, logger }));
  const toolset =
    options.toolset ??
    createTabToolset({
      settings,
      logger,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.registryFetch === undefined ? {} : { registryFetch: options.registryFetch }),
    });

  const server = buildProtocolServer(toolset, logger);

  return {
    server,
    toolset,
    settings,

    async serveStdio() {
      try {
        await server.connect(new StdioServerTransport());
        logger.info("serving on stdio", {
          tools: TAB_TOOLS.length,
          agent: settings.agent ?? null,
          registryUrl: settings.registryUrl ?? null,
        });
        return ok(undefined);
      } catch (error) {
        return fail("INTERNAL", "STDIO_TRANSPORT_FAILED", "the stdio transport could not be started", {
          cause: causeOf(error),
        });
      }
    },

    async serveHttp(serve) {
      const host = serve.host ?? "127.0.0.1";
      const endpoint = serve.endpoint ?? "/mcp";
      try {
        const { createServer } = await import("node:http");
        const http = createServer((req, res) => {
          const url = req.url ?? "/";
          if (!url.startsWith(endpoint)) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(
              safeJson({
                error: { category: "NOT_FOUND", code: "ENDPOINT_UNKNOWN", message: `this server serves MCP at ${endpoint}` },
              }),
            );
            return;
          }
          void handleStatelessRequest(req, res, toolset, logger);
        });

        await new Promise<void>((resolve, reject) => {
          http.once("error", reject);
          http.listen(serve.port, host, () => resolve());
        });

        logger.info("serving streamable http", { host, port: serve.port, endpoint });
        return ok({
          host,
          port: serve.port,
          endpoint,
          close: async () => {
            await new Promise<void>((resolve) => http.close(() => resolve()));
          },
        });
      } catch (error) {
        return fail(
          "INTERNAL",
          "HTTP_TRANSPORT_FAILED",
          `the streamable HTTP transport could not bind ${host}:${serve.port}`,
          { cause: causeOf(error) },
        );
      }
    },
  };
}

/**
 * One request, one server, one transport.
 *
 * This is the documented shape for stateless streamable HTTP and it is not a
 * detail: an MCP connection is a stateful protocol session, and a shared server
 * behind independent POSTs would carry one caller's initialisation into another
 * caller's request. Building a fresh pair per request costs a handful of
 * closures and makes the endpoint genuinely concurrent, which is the only reason
 * to serve HTTP at all rather than stdio.
 *
 * The toolset is shared, deliberately: it holds resolved settings and a memoised
 * strategy registry, neither of which belongs to a caller.
 */
async function handleStatelessRequest(
  req: IncomingMessage,
  res: ServerResponse,
  toolset: TabToolset,
  logger: Logger,
): Promise<void> {
  const server = buildProtocolServer(toolset, logger);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
    await transport.handleRequest(req, res);
  } catch (error) {
    logger.error("streamable http request failed", { reason: String(error) });
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        safeJson({
          error: { category: "INTERNAL", code: "REQUEST_FAILED", message: "the request could not be served" },
        }),
      );
    }
  }
}

/** A protocol server wired to the toolset. One per stdio process, one per HTTP request. */
function buildProtocolServer(toolset: TabToolset, logger: Logger): Server {
  const server = new Server(TAB_MCP_SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TAB_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: { title: tool.title, ...tool.annotations },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const outcome = await runTool(toolset, name, request.params.arguments);
    if (!outcome.ok) {
      const payload = {
        category: outcome.error.category,
        code: outcome.error.code,
        message: outcome.error.message,
        retryable: outcome.error.retryable,
      };
      logger.warn("tool call refused", { tool: name, code: outcome.error.code });
      return { content: [{ type: "text", text: safeJson(payload) }], isError: true };
    }

    const failed = reportsFailure(outcome.value);
    return {
      content: [{ type: "text", text: safeJson(outcome.value) }],
      structuredContent: outcome.value as Record<string, unknown>,
      ...(failed ? { isError: true } : {}),
    };
  });

  return server;
}

/** Runs one tool and validates its output against the schema that was published. */
async function runTool(toolset: TabToolset, name: string, args: unknown): Promise<Result<unknown>> {
  const declaration = tabToolByName(name);
  if (declaration === undefined) {
    return fail("NOT_FOUND", "TOOL_UNKNOWN", `\`${name}\` is not a tool this server declares`, {
      details: { tool: name, declared: TAB_TOOLS.map((tool) => tool.name).join(", ") },
    });
  }

  let payload: unknown;
  try {
    const invoked = await toolset.invoke(name, args);
    if (!invoked.ok) return invoked;
    payload = invoked.value;
  } catch (error) {
    // The toolset is written not to reach here. If it does, the bug is reported
    // as a failed call rather than as a dropped transport.
    return fail("INTERNAL", "TOOL_THREW", `\`${name}\` threw instead of returning a result`, {
      details: { tool: name },
      cause: causeOf(error),
    });
  }

  // The published output schema is enforced on the way out, not just documented.
  // A payload that does not match is this package's bug, and a model told about
  // it is better served than a model handed a shape it was promised would not
  // occur.
  const validated = validateJsonValue<unknown>(declaration.outputSchema, payload, `${name} output`, "OUTPUT_INVALID");
  if (!validated.ok) return validated;
  return ok(payload);
}

/** Does a tool payload report a failure? `ok: false`, or an `error` block on a read tool. */
function reportsFailure(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (field(payload, "ok") === false) return true;
  return isRecord(field(payload, "error"));
}

const causeOf = (error: unknown): { code: string; message: string } =>
  error instanceof Error
    ? { code: error.name, message: error.message }
    : { code: "UNKNOWN", message: String(error) };
