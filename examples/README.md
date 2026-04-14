# cards402 agent examples

Three working integrations showing how to use cards402 from different
environments. Each example is self-contained with its own dependencies.

## Quick start (all examples)

1. Get an API key from your cards402 dashboard
2. Set `CARDS402_API_KEY` in your environment
3. Fund your wallet (MCP: run `setup_wallet`; manual: send XLM to the address)

## Examples

### `node-agent/` — Node.js + cards402 SDK

The recommended path for TypeScript/JavaScript agents. Uses the `cards402`
npm package with the all-in-one `purchaseCardOWS()` helper.

```bash
cd node-agent
npm install
CARDS402_API_KEY=cards402_... OWS_WALLET_NAME=my-agent node index.mjs
```

### `python-agent/` — Python + REST API

Uses the REST API directly via `httpx`. Shows the full create → poll → read
flow. Payment must be completed externally (Stellar SDK or MCP server).

```bash
cd python-agent
pip install -r requirements.txt
CARDS402_API_KEY=cards402_... python main.py
```

### `langchain-tool/` — LangChain custom tools

Three LangChain `BaseTool` subclasses that any LangChain agent can use:

- `Cards402OrderTool` — create a card order
- `Cards402CheckOrderTool` — poll order status / get card details
- `Cards402BudgetTool` — check spend vs limit

```python
from cards402_tool import Cards402OrderTool, Cards402CheckOrderTool, Cards402BudgetTool

tools = [Cards402OrderTool(), Cards402CheckOrderTool(), Cards402BudgetTool()]
agent = initialize_agent(tools, llm, agent=AgentType.OPENAI_FUNCTIONS)
agent.run("Buy me a $5 virtual Visa card")
```

## MCP server (Claude Code / Claude Desktop)

The fastest path for Claude-based agents. No code needed — just configure:

```json
{
  "mcpServers": {
    "cards402": {
      "command": "npx",
      "args": ["-y", "cards402@latest"],
      "env": {
        "CARDS402_API_KEY": "cards402_...",
        "OWS_WALLET_NAME": "my-agent"
      }
    }
  }
}
```

The `cards402` CLI defaults to the `mcp` subcommand when no other subcommand
is passed, so `npx cards402@latest` with no args runs the MCP server. `-y`
auto-accepts the one-time install prompt. **Always pin `@latest`** — without
it, `npx` serves whatever version it first resolved from its local cache
indefinitely, so SDK patch releases (particularly the ones touching on-chain
payment paths) don't reach the agent until the operator manually clears the
npx cache. With `@latest`, every invocation re-resolves against the registry.

Then ask Claude: "Buy me a $10 virtual Visa card."

## API reference

See [`contract/api/agent-api.openapi.yaml`](../contract/api/agent-api.openapi.yaml)
for the full OpenAPI spec of the agent-facing API.
