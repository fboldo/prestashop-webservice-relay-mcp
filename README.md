# PrestaShop Webservice Relay MCP Server

MCP (Model Context Protocol) server that exposes the PrestaShop Webservice API over stdio or Streamable HTTP, focused on PrestaShop v1.7+ stores.

## Why it exists

PrestaShop has an [official MCP Server module](https://addons.prestashop.com/en/administrative-tools/96617-prestashop-mcp-server.html), but it targets PrestaShop 8.2+ and is not compatible with older stores. This relay exists for shops that still expose the classic PrestaShop Webservice API, especially v1.7-era installations.

It authenticates the same way as the PrestaShop Webservice examples, with the Webservice key as the Basic auth username and an empty password:

```bash
curl -u YOUR_PRESTASHOP_WEBSERVICE_KEY: https://yourstore.com/api/
```

## Install

```bash
bun install
```

## Configuration

The server accepts the store base URL and Webservice key either as environment variables or CLI flags.

```bash
export PRESTASHOP_BASE_URL="https://yourstore.com"
export PRESTASHOP_WEBSERVICE_KEY="YOUR_PRESTASHOP_WEBSERVICE_KEY"

bun run index.ts
```

Or:

```bash
bun run index.ts --base-url https://yourstore.com --key YOUR_PRESTASHOP_WEBSERVICE_KEY
```

If you pass `https://yourstore.com`, the relay calls `https://yourstore.com/api`. Passing `https://yourstore.com/api` also works.

Optional environment variables:

- `PRESTASHOP_TIMEOUT_MS`: request timeout in milliseconds, default `30000`
- `PRESTASHOP_API_KEY`: fallback name for `PRESTASHOP_WEBSERVICE_KEY`
- `PRESTASHOP_WEBSERVICE_URL`: fallback name for `PRESTASHOP_BASE_URL`
- `PRESTASHOP_MCP_TRANSPORT`: `stdio` or `http`, default `stdio`
- `HOST`: HTTP bind host, default `127.0.0.1`
- `PORT`: HTTP port, default `3000`
- `MCP_HTTP_PATH`: HTTP MCP endpoint path, default `/mcp`

## HTTP Transport

Launch the server with Streamable HTTP instead of stdio:

```bash
bun run index.ts --transport http --host 127.0.0.1 --port 3000
```

The MCP endpoint is available at:

```text
http://127.0.0.1:3000/mcp
```

A simple health endpoint is available at:

```text
http://127.0.0.1:3000/health
```

Equivalent environment-based launch:

```bash
PRESTASHOP_MCP_TRANSPORT=http PORT=3000 bun run index.ts
```

## MCP Client Example

For a stdio MCP client, configure the command with your store credentials in the environment:

```json
{
  "mcpServers": {
    "prestashop": {
      "command": "bun",
      "args": ["run", "/home/filipeboldo/Apps/prestashop-webservice-relay-mcp/index.ts"],
      "env": {
        "PRESTASHOP_BASE_URL": "https://yourstore.com",
        "PRESTASHOP_WEBSERVICE_KEY": "YOUR_PRESTASHOP_WEBSERVICE_KEY"
      }
    }
  }
}
```

For an MCP client that supports Streamable HTTP, point it at `http://127.0.0.1:3000/mcp` after starting the server in HTTP mode.

## Tools

- `prestashop_introspect`: calls `/api/` and returns exposed resources, resource URLs, shop name, and method permissions.
- `prestashop_get_resource_schema`: calls `/api/{resource}?schema=synopsis` or `schema=blank` to inspect fields or get XML templates.
- `prestashop_list_resources`: calls `/api/{resource}` with native `display`, `filter[field]`, `sort`, and `limit` query support.
- `prestashop_get_resource`: calls `/api/{resource}/{id}`.
- `prestashop_create_resource`: POSTs XML to `/api/{resource}`.
- `prestashop_update_resource`: PUTs XML to `/api/{resource}/{id}`.
- `prestashop_delete_resource`: DELETEs `/api/{resource}/{id}`.
- `prestashop_request`: advanced generic relay for nested or less common Webservice endpoints, such as image endpoints.

All tools default to parsed JSON-style output. Set `response_format` to `xml` to return raw PrestaShop XML.

## Common Workflow

1. Call `prestashop_introspect` to verify credentials and see exposed resources.
2. Call `prestashop_get_resource_schema` with `schema=synopsis` to inspect a resource.
3. Use `prestashop_list_resources` with a small `limit`, for example `0,20`.
4. For writes, call `prestashop_get_resource_schema` with `schema=blank`, fill the XML, then use create or update.

Example PrestaShop list query arguments:

```json
{
  "resource": "products",
  "display": "[id,name,price,active]",
  "filters": {
    "active": "[1]"
  },
  "sort": "[id_DESC]",
  "limit": "0,20"
}
```

## Development

```bash
bun run typecheck
bun run index.ts --help
bun run start:http
```
