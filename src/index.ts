#!/usr/bin/env bun

import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { XMLParser } from "fast-xml-parser";
import * as z from "zod/v4";

const SERVER_NAME = "prestashop-webservice-mcp-server";
const SERVER_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 30_000;
const CHARACTER_LIMIT = 30_000;
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_PATH = "/mcp";
const MAX_HTTP_BODY_BYTES = 1_000_000;

const xmlParser = new XMLParser({
  attributeNamePrefix: "@",
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  textNodeName: "#text",
  trimValues: true,
});

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
type ResponseFormat = "json" | "xml";
type TransportMode = "stdio" | "http";
type QueryValue = string | number | boolean | null | undefined;
type QueryParams = Record<string, QueryValue | QueryValue[]>;

interface RuntimeConfig {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  transportMode: TransportMode;
  httpHost: string;
  httpPort: number;
  httpPath: string;
}

interface ParsedCliArgs {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  transportMode?: TransportMode;
  httpHost?: string;
  httpPort?: number;
  httpPath?: string;
  help: boolean;
}

interface PrestaShopResponse {
  status: number;
  ok: boolean;
  url: string;
  contentType: string;
  body: string;
}

class ConfigError extends Error {
  override name = "ConfigError";
}

class PrestaShopError extends Error {
  override name = "PrestaShopError";

  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(message);
  }
}

const cliArgs = parseCliArgs(process.argv.slice(2));

if (cliArgs.help) {
  printHelp();
  process.exit(0);
}

const runtimeConfig: RuntimeConfig = {
  baseUrl:
    cliArgs.baseUrl ??
    process.env.PRESTASHOP_BASE_URL ??
    process.env.PRESTASHOP_WEBSERVICE_URL,
  apiKey:
    cliArgs.apiKey ??
    process.env.PRESTASHOP_WEBSERVICE_KEY ??
    process.env.PRESTASHOP_API_KEY,
  timeoutMs:
    cliArgs.timeoutMs ??
    parsePositiveInteger(process.env.PRESTASHOP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  transportMode:
    cliArgs.transportMode ??
    parseTransportMode(process.env.PRESTASHOP_MCP_TRANSPORT ?? process.env.MCP_TRANSPORT, "stdio"),
  httpHost: cliArgs.httpHost ?? process.env.HOST ?? DEFAULT_HTTP_HOST,
  httpPort: cliArgs.httpPort ?? parsePositiveInteger(process.env.PORT, DEFAULT_HTTP_PORT),
  httpPath: normalizeHttpPath(cliArgs.httpPath ?? process.env.MCP_HTTP_PATH ?? DEFAULT_HTTP_PATH),
};

const ResponseFormatSchema = z
  .enum(["json", "xml"])
  .default("json")
  .describe("Use 'json' for parsed output or 'xml' for raw PrestaShop XML.");

const ResourceNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_]+$/, "Use a PrestaShop Webservice resource name such as products, customers, orders, or cart_rules.")
  .describe("PrestaShop Webservice resource name, for example products, customers, orders, or cart_rules.");

const ResourceIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, "Use the resource ID exactly as exposed by PrestaShop.")
  .describe("Resource identifier, usually a numeric PrestaShop ID.");

const QueryRecordSchema = z
  .record(z.string().min(1), z.string())
  .describe("Additional PrestaShop query parameters as key/value strings.");

const CommonOutputSchema = {
  status: z.number(),
  ok: z.boolean(),
  url: z.string(),
  format: z.string(),
  data: z.unknown().optional(),
  raw_body: z.string().optional(),
  truncated: z.boolean().optional(),
  truncation_message: z.string().optional(),
};

function createPrestaShopMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

server.registerTool(
  "prestashop_introspect",
  {
    title: "Inspect PrestaShop Webservice",
    description:
      "Fetch /api/ from the configured PrestaShop Webservice and return the available resources, hrefs, shop name, and HTTP method permissions. Use this first to discover what the store exposes.",
    inputSchema: {
      response_format: ResponseFormatSchema,
    },
    outputSchema: {
      status: z.number(),
      ok: z.boolean(),
      url: z.string(),
      shop_name: z.string().optional(),
      resources: z.array(
        z.object({
          name: z.string(),
          href: z.string().optional(),
          permissions: z.record(z.string(), z.boolean()),
        }),
      ),
      raw: z.unknown().optional(),
      truncated: z.boolean().optional(),
      truncation_message: z.string().optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ response_format }) => {
    try {
      const response = await requestPrestaShop({
        method: "GET",
        path: "",
        query: {},
        responseFormat: response_format,
      });
      const parsed = parseResponseBody(response.body, response.contentType, "json");
      const introspection = extractIntrospection(parsed.data);
      const output = trimStructuredOutput({
        status: response.status,
        ok: response.ok,
        url: response.url,
        shop_name: introspection.shopName,
        resources: introspection.resources,
        raw: response_format === "json" ? parsed.data : undefined,
      });

      return makeJsonResult(output);
    } catch (error) {
      return makeErrorResult(error);
    }
  },
);

server.registerTool(
  "prestashop_get_resource_schema",
  {
    title: "Get PrestaShop Resource Schema",
    description:
      "Fetch a PrestaShop Webservice resource schema using ?schema=synopsis or ?schema=blank. Use synopsis to inspect fields and blank to get an XML template for create/update payloads.",
    inputSchema: {
      resource: ResourceNameSchema,
      schema: z
        .enum(["synopsis", "blank"])
        .default("synopsis")
        .describe("Use synopsis for field metadata or blank for an XML payload template."),
      response_format: ResponseFormatSchema,
    },
    outputSchema: CommonOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ resource, schema, response_format }) => {
    try {
      const response = await requestPrestaShop({
        method: "GET",
        path: resource,
        query: { schema, ...(response_format === "json" ? { output_format: "JSON" } : {}) },
        responseFormat: response_format,
      });

      return makeResponseResult(response, response_format);
    } catch (error) {
      return makeErrorResult(error);
    }
  },
);

server.registerTool(
  "prestashop_list_resources",
  {
    title: "List PrestaShop Resources",
    description:
      "List records from a PrestaShop Webservice resource. Supports native Webservice display, filter[field], sort, limit, and arbitrary extra query parameters for v1.7+ stores.",
    inputSchema: {
      resource: ResourceNameSchema,
      display: z
        .string()
        .min(1)
        .optional()
        .describe("PrestaShop display selector, for example full, [id,name], or [id,date_add,total_paid]. Omit to use the store default."),
      filters: z
        .record(z.string().min(1), z.string())
        .optional()
        .describe("PrestaShop filters. The key becomes filter[key], for example {\"id\": \"[1|2]\", \"date_add\": \"[2024-01-01,2024-12-31]\"}."),
      sort: z
        .string()
        .min(1)
        .optional()
        .describe("PrestaShop sort expression, for example [id_ASC] or [date_add_DESC]."),
      limit: z
        .string()
        .min(1)
        .optional()
        .describe("PrestaShop limit expression, for example 50 or 0,50."),
      extra_query: QueryRecordSchema.optional(),
      response_format: ResponseFormatSchema,
    },
    outputSchema: CommonOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ resource, display, filters, sort, limit, extra_query, response_format }) => {
    try {
      const query = buildListQuery({
        display,
        filters,
        sort,
        limit,
        extraQuery: extra_query,
        responseFormat: response_format,
      });
      const response = await requestPrestaShop({
        method: "GET",
        path: resource,
        query,
        responseFormat: response_format,
      });

      return makeResponseResult(response, response_format);
    } catch (error) {
      return makeErrorResult(error);
    }
  },
);

server.registerTool(
  "prestashop_get_resource",
  {
    title: "Get PrestaShop Resource",
    description:
      "Fetch one PrestaShop Webservice record by resource name and ID, optionally passing extra query parameters such as display or language.",
    inputSchema: {
      resource: ResourceNameSchema,
      id: ResourceIdSchema,
      extra_query: QueryRecordSchema.optional(),
      response_format: ResponseFormatSchema,
    },
    outputSchema: CommonOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ resource, id, extra_query, response_format }) => {
    try {
      const response = await requestPrestaShop({
        method: "GET",
        path: `${resource}/${id}`,
        query: withResponseFormat(extra_query ?? {}, response_format),
        responseFormat: response_format,
      });

      return makeResponseResult(response, response_format);
    } catch (error) {
      return makeErrorResult(error);
    }
  },
);

server.registerTool(
  "prestashop_create_resource",
  {
    title: "Create PrestaShop Resource",
    description:
      "Create a PrestaShop Webservice record by POSTing XML to /api/{resource}. Use prestashop_get_resource_schema with schema=blank first to get the expected XML payload shape.",
    inputSchema: {
      resource: ResourceNameSchema,
      xml: z
        .string()
        .min(1)
        .describe("Complete PrestaShop XML payload, usually rooted at <prestashop><resource>...</resource></prestashop>."),
      extra_query: QueryRecordSchema.optional(),
      response_format: ResponseFormatSchema,
    },
    outputSchema: CommonOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ resource, xml, extra_query, response_format }) => {
    try {
      const response = await requestPrestaShop({
        method: "POST",
        path: resource,
        query: withResponseFormat(extra_query ?? {}, response_format),
        body: xml,
        responseFormat: response_format,
      });

      return makeResponseResult(response, response_format);
    } catch (error) {
      return makeErrorResult(error);
    }
  },
);

server.registerTool(
  "prestashop_update_resource",
  {
    title: "Update PrestaShop Resource",
    description:
      "Update a PrestaShop Webservice record by PUTing XML to /api/{resource}/{id}. PrestaShop usually requires a full XML entity including the id field.",
    inputSchema: {
      resource: ResourceNameSchema,
      id: ResourceIdSchema,
      xml: z
        .string()
        .min(1)
        .describe("Complete PrestaShop XML payload for the updated entity, usually including the id field."),
      extra_query: QueryRecordSchema.optional(),
      response_format: ResponseFormatSchema,
    },
    outputSchema: CommonOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ resource, id, xml, extra_query, response_format }) => {
    try {
      const response = await requestPrestaShop({
        method: "PUT",
        path: `${resource}/${id}`,
        query: withResponseFormat(extra_query ?? {}, response_format),
        body: xml,
        responseFormat: response_format,
      });

      return makeResponseResult(response, response_format);
    } catch (error) {
      return makeErrorResult(error);
    }
  },
);

server.registerTool(
  "prestashop_delete_resource",
  {
    title: "Delete PrestaShop Resource",
    description:
      "Delete one PrestaShop Webservice record by resource name and ID using DELETE /api/{resource}/{id}.",
    inputSchema: {
      resource: ResourceNameSchema,
      id: ResourceIdSchema,
      extra_query: QueryRecordSchema.optional(),
      response_format: ResponseFormatSchema,
    },
    outputSchema: CommonOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ resource, id, extra_query, response_format }) => {
    try {
      const response = await requestPrestaShop({
        method: "DELETE",
        path: `${resource}/${id}`,
        query: withResponseFormat(extra_query ?? {}, response_format),
        responseFormat: response_format,
      });

      return makeResponseResult(response, response_format);
    } catch (error) {
      return makeErrorResult(error);
    }
  },
);

server.registerTool(
  "prestashop_request",
  {
    title: "Relay PrestaShop Webservice Request",
    description:
      "Send a generic request to the configured PrestaShop /api path for advanced Webservice cases, including nested endpoints such as images/products/1. Use the specific list/get/create/update/delete tools when they fit.",
    inputSchema: {
      method: z
        .enum(["GET", "POST", "PUT", "DELETE", "HEAD"])
        .default("GET")
        .describe("HTTP method to send to the PrestaShop Webservice."),
      path: z
        .string()
        .min(1)
        .describe("Path below /api, for example products, products/1, or images/products/1. Do not include the store domain."),
      query: QueryRecordSchema.optional(),
      xml_body: z
        .string()
        .optional()
        .describe("XML request body for POST or PUT requests."),
      response_format: ResponseFormatSchema,
    },
    outputSchema: CommonOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ method, path, query, xml_body, response_format }) => {
    try {
      const response = await requestPrestaShop({
        method,
        path,
        query: withResponseFormat(query ?? {}, response_format),
        body: xml_body,
        responseFormat: response_format,
      });

      return makeResponseResult(response, response_format);
    } catch (error) {
      return makeErrorResult(error);
    }
  },
);

  return server;
}

async function main(): Promise<void> {
  if (runtimeConfig.transportMode === "http") {
    await startHttpServer();
    return;
  }

  await startStdioServer();
}

async function startStdioServer(): Promise<void> {
  const server = createPrestaShopMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (!runtimeConfig.baseUrl || !runtimeConfig.apiKey) {
    console.error(
      `${SERVER_NAME} running on stdio. Set PRESTASHOP_BASE_URL and PRESTASHOP_WEBSERVICE_KEY, or pass --base-url and --key, before calling tools.`,
    );
    return;
  }

  console.error(`${SERVER_NAME} running on stdio for ${safeStoreLabel(runtimeConfig.baseUrl)}.`);
}

async function startHttpServer(): Promise<void> {
  const httpServer = createServer((request, response) => {
    void handleHttpRequest(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(runtimeConfig.httpPort, runtimeConfig.httpHost, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const displayHost = runtimeConfig.httpHost === "0.0.0.0" ? "localhost" : runtimeConfig.httpHost;
  console.error(
    `${SERVER_NAME} listening on Streamable HTTP at http://${displayHost}:${runtimeConfig.httpPort}${runtimeConfig.httpPath}.`,
  );

  if (!runtimeConfig.baseUrl || !runtimeConfig.apiKey) {
    console.error(
      "PrestaShop credentials are not configured yet. Set PRESTASHOP_BASE_URL and PRESTASHOP_WEBSERVICE_KEY before calling tools.",
    );
  }

  const shutdown = (): void => {
    httpServer.close(() => process.exit(0));
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "http",
      mcp_path: runtimeConfig.httpPath,
    });
    return;
  }

  if (requestUrl.pathname !== runtimeConfig.httpPath) {
    sendJson(response, 404, {
      jsonrpc: "2.0",
      error: {
        code: -32004,
        message: `Not found. MCP Streamable HTTP endpoint is ${runtimeConfig.httpPath}.`,
      },
      id: null,
    });
    return;
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST, OPTIONS");
    sendJson(response, 405, {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. Use POST for stateless MCP Streamable HTTP requests.",
      },
      id: null,
    });
    return;
  }

  let parsedBody: unknown;

  try {
    parsedBody = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, {
      jsonrpc: "2.0",
      error: {
        code: -32700,
        message: error instanceof Error ? error.message : "Invalid JSON request body.",
      },
      id: null,
    });
    return;
  }

  const mcpServer = createPrestaShopMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(request, response, parsedBody);
  } catch (error) {
    console.error(formatError(error));

    if (!response.headersSent) {
      sendJson(response, 500, {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error.",
        },
        id: null,
      });
    }
  } finally {
    await transport.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bodySize = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodySize += buffer.byteLength;

    if (bodySize > MAX_HTTP_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_HTTP_BODY_BYTES} bytes.`);
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const body = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON request body.");
  }
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  );
  response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function parseCliArgs(args: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = { help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--http") {
      parsed.transportMode = "http";
      continue;
    }

    if (arg === "--stdio") {
      parsed.transportMode = "stdio";
      continue;
    }

    if (arg.startsWith("--transport=")) {
      parsed.transportMode = parseTransportMode(arg.slice("--transport=".length), "stdio");
      continue;
    }

    if (arg === "--transport") {
      parsed.transportMode = parseTransportMode(args[index + 1], "stdio");
      index += 1;
      continue;
    }

    if (arg.startsWith("--host=")) {
      parsed.httpHost = arg.slice("--host=".length);
      continue;
    }

    if (arg === "--host") {
      parsed.httpHost = args[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      parsed.httpPort = parsePositiveInteger(arg.slice("--port=".length), DEFAULT_HTTP_PORT);
      continue;
    }

    if (arg === "--port") {
      parsed.httpPort = parsePositiveInteger(args[index + 1], DEFAULT_HTTP_PORT);
      index += 1;
      continue;
    }

    if (arg.startsWith("--http-path=")) {
      parsed.httpPath = arg.slice("--http-path=".length);
      continue;
    }

    if (arg === "--http-path") {
      parsed.httpPath = args[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--base-url=")) {
      parsed.baseUrl = arg.slice("--base-url=".length);
      continue;
    }

    if (arg === "--base-url") {
      parsed.baseUrl = args[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--key=")) {
      parsed.apiKey = arg.slice("--key=".length);
      continue;
    }

    if (arg === "--key") {
      parsed.apiKey = args[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), DEFAULT_TIMEOUT_MS);
      continue;
    }

    if (arg === "--timeout-ms") {
      parsed.timeoutMs = parsePositiveInteger(args[index + 1], DEFAULT_TIMEOUT_MS);
      index += 1;
    }
  }

  return parsed;
}

function printHelp(): void {
  console.log(`PrestaShop Webservice MCP relay

Usage:
  bun run index.ts --base-url https://yourstore.com --key CHANNABLE1589f7cbdac794b64fd3e93
  bun run index.ts --transport http --port 3000 --base-url https://yourstore.com --key CHANNABLE1589f7cbdac794b64fd3e93

Environment variables:
  PRESTASHOP_BASE_URL          Store URL or /api URL, for example https://yourstore.com
  PRESTASHOP_WEBSERVICE_KEY    PrestaShop Webservice key; used as Basic auth username with an empty password
  PRESTASHOP_TIMEOUT_MS        Optional request timeout in milliseconds, default ${DEFAULT_TIMEOUT_MS}
  PRESTASHOP_MCP_TRANSPORT     stdio or http, default stdio
  HOST                         HTTP bind host, default ${DEFAULT_HTTP_HOST}
  PORT                         HTTP port, default ${DEFAULT_HTTP_PORT}
  MCP_HTTP_PATH                HTTP MCP endpoint path, default ${DEFAULT_HTTP_PATH}

Compatible with PrestaShop Webservice v1.7+ over stdio and Streamable HTTP MCP transports.`);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const numberValue = Number.parseInt(value, 10);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function parseTransportMode(value: string | undefined, fallback: TransportMode): TransportMode {
  return value === "http" || value === "stdio" ? value : fallback;
}

function normalizeHttpPath(path: string): string {
  const trimmed = path.trim();

  if (!trimmed || trimmed.includes("?") || trimmed.includes("#")) {
    return DEFAULT_HTTP_PATH;
  }

  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const normalized = withSlash.replace(/\/+$/, "");

  if (normalized.split("/").includes("..")) {
    return DEFAULT_HTTP_PATH;
  }

  return normalized || DEFAULT_HTTP_PATH;
}

function getApiConfig(): { apiBaseUrl: string; apiKey: string; timeoutMs: number } {
  if (!runtimeConfig.baseUrl) {
    throw new ConfigError(
      "Missing PrestaShop base URL. Set PRESTASHOP_BASE_URL or launch the server with --base-url https://yourstore.com.",
    );
  }

  if (!runtimeConfig.apiKey) {
    throw new ConfigError(
      "Missing PrestaShop Webservice key. Set PRESTASHOP_WEBSERVICE_KEY or launch the server with --key YOUR_KEY.",
    );
  }

  return {
    apiBaseUrl: normalizeApiBaseUrl(runtimeConfig.baseUrl),
    apiKey: runtimeConfig.apiKey,
    timeoutMs: runtimeConfig.timeoutMs,
  };
}

function normalizeApiBaseUrl(baseUrl: string): string {
  let url: URL;

  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError(
      `Invalid PrestaShop base URL '${baseUrl}'. Include the protocol, for example https://yourstore.com.`,
    );
  }

  url.hash = "";
  url.search = "";
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  url.pathname = normalizedPath.endsWith("/api") ? normalizedPath : `${normalizedPath}/api`;

  return url.toString().replace(/\/+$/, "");
}

function safeStoreLabel(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.origin;
  } catch {
    return "configured store";
  }
}

async function requestPrestaShop(params: {
  method: HttpMethod;
  path: string;
  query?: QueryParams;
  body?: string;
  responseFormat: ResponseFormat;
}): Promise<PrestaShopResponse> {
  const { apiBaseUrl, apiKey, timeoutMs } = getApiConfig();
  const url = buildApiUrl(apiBaseUrl, params.path, params.query ?? {});
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`,
    Accept:
      params.responseFormat === "json"
        ? "application/json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1"
        : "application/xml, text/xml, */*;q=0.1",
    "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
  };

  if (params.body !== undefined) {
    headers["Content-Type"] = "application/xml; charset=utf-8";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: params.method,
      headers,
      body: params.method === "GET" || params.method === "HEAD" ? undefined : params.body,
      signal: controller.signal,
    });

    const body = params.method === "HEAD" ? "" : await response.text();

    if (!response.ok) {
      throw new PrestaShopError(
        buildHttpErrorMessage(response.status, url.toString(), body),
        response.status,
        url.toString(),
        body,
      );
    }

    return {
      status: response.status,
      ok: response.ok,
      url: url.toString(),
      contentType: response.headers.get("content-type") ?? "",
      body,
    };
  } catch (error) {
    if (error instanceof PrestaShopError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `PrestaShop request timed out after ${timeoutMs}ms. Try a smaller limit/display query or increase PRESTASHOP_TIMEOUT_MS.`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildApiUrl(apiBaseUrl: string, path: string, query: QueryParams): URL {
  const safePath = sanitizeApiPath(path);
  const url = new URL(`${apiBaseUrl}/${safePath}`);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          url.searchParams.append(key, String(item));
        }
      }
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url;
}

function sanitizeApiPath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const withoutApiPrefix = trimmed === "api" ? "" : trimmed.startsWith("api/") ? trimmed.slice(4) : trimmed;

  if (withoutApiPrefix.includes("?") || withoutApiPrefix.includes("#")) {
    throw new Error("Pass query parameters through the query or extra_query input instead of embedding them in path.");
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutApiPrefix) || withoutApiPrefix.split("/").includes("..")) {
    throw new Error("Path must be relative to the configured PrestaShop /api endpoint.");
  }

  return withoutApiPrefix
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function buildListQuery(params: {
  display?: string;
  filters?: Record<string, string>;
  sort?: string;
  limit?: string;
  extraQuery?: Record<string, string>;
  responseFormat: ResponseFormat;
}): QueryParams {
  const query: QueryParams = { ...(params.extraQuery ?? {}) };

  if (params.display) query.display = params.display;
  if (params.sort) query.sort = params.sort;
  if (params.limit) query.limit = params.limit;

  for (const [field, value] of Object.entries(params.filters ?? {})) {
    query[`filter[${field}]`] = value;
  }

  return withResponseFormat(query, params.responseFormat);
}

function withResponseFormat(query: Record<string, string> | QueryParams, responseFormat: ResponseFormat): QueryParams {
  if (responseFormat !== "json") {
    return query;
  }

  return {
    ...query,
    output_format: query.output_format ?? "JSON",
  };
}

function parseResponseBody(body: string, contentType: string, responseFormat: ResponseFormat): { format: string; data?: unknown; rawBody?: string } {
  if (!body.trim()) {
    return { format: "empty", data: null };
  }

  if (responseFormat === "xml") {
    return { format: "xml", rawBody: body };
  }

  if (contentType.includes("json") || body.trimStart().startsWith("{") || body.trimStart().startsWith("[")) {
    try {
      return { format: "json", data: JSON.parse(body) };
    } catch {
      return { format: "text", rawBody: body };
    }
  }

  try {
    return { format: "xml", data: xmlParser.parse(body) };
  } catch {
    return { format: "text", rawBody: body };
  }
}

function makeResponseResult(response: PrestaShopResponse, responseFormat: ResponseFormat) {
  const parsed = parseResponseBody(response.body, response.contentType, responseFormat);
  const output = trimStructuredOutput({
    status: response.status,
    ok: response.ok,
    url: response.url,
    format: parsed.format,
    ...(parsed.data !== undefined ? { data: parsed.data } : {}),
    ...(parsed.rawBody !== undefined ? { raw_body: parsed.rawBody } : {}),
  });

  return makeJsonResult(output);
}

function makeJsonResult(output: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: stringifyLimited(output),
      },
    ],
    structuredContent: output,
  };
}

function makeErrorResult(error: unknown) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: formatError(error),
      },
    ],
  };
}

function trimStructuredOutput<T extends Record<string, unknown>>(output: T): T {
  const serialized = JSON.stringify(output);

  if (serialized.length <= CHARACTER_LIMIT) {
    return output;
  }

  const trimmed: Record<string, unknown> = {
    ...output,
    truncated: true,
    truncation_message: `Response exceeded ${CHARACTER_LIMIT} characters. Use display, filters, limit, or response_format=xml to narrow the request.`,
  };

  if (typeof trimmed.raw_body === "string") {
    trimmed.raw_body = limitString(trimmed.raw_body);
  }

  if (trimmed.data !== undefined) {
    trimmed.data = {
      preview: limitString(JSON.stringify(trimmed.data, null, 2)),
    };
  }

  if (trimmed.raw !== undefined) {
    trimmed.raw = {
      preview: limitString(JSON.stringify(trimmed.raw, null, 2)),
    };
  }

  return trimmed as T;
}

function stringifyLimited(value: unknown): string {
  return limitString(JSON.stringify(value, null, 2));
}

function limitString(value: string): string {
  if (value.length <= CHARACTER_LIMIT) {
    return value;
  }

  return `${value.slice(0, CHARACTER_LIMIT)}\n... truncated after ${CHARACTER_LIMIT} characters ...`;
}

function extractIntrospection(data: unknown): {
  shopName?: string;
  resources: Array<{ name: string; href?: string; permissions: Record<string, boolean> }>;
} {
  const api = asRecord(asRecord(data)?.prestashop)?.api;

  if (!isRecord(api)) {
    return { resources: [] };
  }

  const resources: Array<{ name: string; href?: string; permissions: Record<string, boolean> }> = [];
  const shopName = stringValue(api["@shopName"]);

  for (const [name, value] of Object.entries(api)) {
    if (name.startsWith("@")) continue;
    const resource = Array.isArray(value) ? value[0] : value;
    const attrs = asRecord(resource);

    resources.push({
      name,
      href: stringValue(attrs?.["@xlink:href"] ?? attrs?.["@href"]),
      permissions: {
        get: booleanAttribute(attrs?.["@get"]),
        put: booleanAttribute(attrs?.["@put"]),
        post: booleanAttribute(attrs?.["@post"]),
        delete: booleanAttribute(attrs?.["@delete"]),
        head: booleanAttribute(attrs?.["@head"]),
      },
    });
  }

  return { shopName, resources };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanAttribute(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

function buildHttpErrorMessage(status: number, url: string, body: string): string {
  const preview = limitString(body.trim() || "No response body.");

  switch (status) {
    case 401:
      return `PrestaShop returned 401 Unauthorized for ${url}. Check that PRESTASHOP_WEBSERVICE_KEY is correct and Webservice is enabled. Response: ${preview}`;
    case 403:
      return `PrestaShop returned 403 Forbidden for ${url}. Check the Webservice key permissions for this resource and HTTP method. Response: ${preview}`;
    case 404:
      return `PrestaShop returned 404 Not Found for ${url}. Check the base URL, resource name, and id. Response: ${preview}`;
    case 405:
      return `PrestaShop returned 405 Method Not Allowed for ${url}. Check the Webservice key method permissions and endpoint support. Response: ${preview}`;
    default:
      return `PrestaShop request failed with HTTP ${status} for ${url}. Response: ${preview}`;
  }
}

function formatError(error: unknown): string {
  if (error instanceof ConfigError) {
    return `Configuration error: ${error.message}`;
  }

  if (error instanceof PrestaShopError) {
    return error.message;
  }

  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }

  return `Error: ${String(error)}`;
}

main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exit(1);
});
