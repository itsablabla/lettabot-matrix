# E2B MCP Gateway

Exposes the [E2B MCP server](https://github.com/e2b-dev/mcp-server) as a Letta-compatible HTTP endpoint.

## What it does
- Wraps `@e2b/mcp-server` (stdio) with an HTTP transport
- Exposes `/mcp` (streamable HTTP) and `/sse` endpoints for Letta
- Provides `/run` endpoint for direct code execution
- Gives all 34+ Letta agents the ability to **run Python code in sandboxes**

## Environment Variables
| Variable | Description |
|----------|-------------|
| `E2B_API_KEY` | Your E2B API key |
| `PORT` | Port to listen on (Railway sets this automatically) |

## Deploy to Railway
1. Fork this repo
2. Create new Railway service from this directory
3. Set `E2B_API_KEY` env var
4. Deploy!

## Endpoints
- `GET /health` - Health check
- `POST /mcp` - Streamable HTTP MCP endpoint (for Letta)
- `GET /sse` - SSE MCP endpoint
- `POST /run` - Direct code execution `{code: "print('hello')"}`

## Register in Letta
```python
from letta_client import Letta
client = Letta(base_url="https://app.letta.com", api_key="...")
client.mcp_servers.create(
    server_name="e2b",
    server_type="streamable_http", 
    url="https://your-railway-url.up.railway.app/mcp"
)
```
