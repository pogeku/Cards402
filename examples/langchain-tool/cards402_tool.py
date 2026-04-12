"""
cards402 LangChain tool — lets any LangChain agent purchase virtual Visa cards.

Prerequisites:
  pip install langchain httpx
  export CARDS402_API_KEY=<your key>

Usage in a LangChain agent:

    from cards402_tool import Cards402OrderTool, Cards402CheckOrderTool, Cards402BudgetTool

    tools = [Cards402OrderTool(), Cards402CheckOrderTool(), Cards402BudgetTool()]
    agent = initialize_agent(tools, llm, agent=AgentType.OPENAI_FUNCTIONS)
    agent.run("Buy me a $5 virtual Visa card")

The tools handle the REST API calls. Payment must still be completed outside
LangChain (via the MCP server, the Node SDK, or direct Stellar calls) unless
you wire up a custom Stellar tool as well.
"""

import os
import httpx
from langchain.tools import BaseTool
from pydantic import BaseModel, Field

BASE_URL = os.environ.get("CARDS402_BASE_URL", "https://api.cards402.com/v1")
API_KEY = os.environ.get("CARDS402_API_KEY", "")


def _headers():
    return {"X-Api-Key": API_KEY, "Content-Type": "application/json"}


class OrderInput(BaseModel):
    amount_usdc: str = Field(description="Card value in USD, e.g. '10.00'")


class Cards402OrderTool(BaseTool):
    name: str = "cards402_create_order"
    description: str = (
        "Create a new virtual Visa card order on cards402. "
        "Returns payment instructions (Soroban contract call). "
        "The card is delivered after the agent pays the contract on Stellar."
    )
    args_schema: type = OrderInput

    def _run(self, amount_usdc: str) -> str:
        resp = httpx.post(
            f"{BASE_URL}/orders",
            headers=_headers(),
            json={"amount_usdc": amount_usdc},
            timeout=30,
        )
        if not resp.is_success:
            return f"Error: {resp.status_code} {resp.text[:200]}"
        data = resp.json()
        order_id = data.get("order_id", "?")
        phase = data.get("phase", "?")
        payment = data.get("payment", {})
        lines = [
            f"Order {order_id} created (phase: {phase})",
            f"Amount: ${amount_usdc}",
        ]
        if payment.get("contract_id"):
            lines.append(f"Pay contract: {payment['contract_id']}")
            if "xlm" in payment:
                lines.append(f"XLM amount: {payment['xlm']['amount']}")
            lines.append(f"Order ID arg: {payment.get('order_id', order_id)}")
        lines.append(f"Poll: GET /v1/orders/{order_id}")
        return "\n".join(lines)


class CheckOrderInput(BaseModel):
    order_id: str = Field(description="The cards402 order UUID")


class Cards402CheckOrderTool(BaseTool):
    name: str = "cards402_check_order"
    description: str = (
        "Check the status of a cards402 order. "
        "Returns card details (number, CVV, expiry) when phase is 'ready'."
    )
    args_schema: type = CheckOrderInput

    def _run(self, order_id: str) -> str:
        resp = httpx.get(
            f"{BASE_URL}/orders/{order_id}",
            headers=_headers(),
            timeout=15,
        )
        if not resp.is_success:
            return f"Error: {resp.status_code}"
        data = resp.json()
        lines = [
            f"Order: {data.get('order_id', order_id)}",
            f"Phase: {data.get('phase', '?')}",
            f"Amount: ${data.get('amount_usdc', '?')}",
        ]
        card = data.get("card")
        if card:
            lines.append(f"Card: {card['number']} CVV: {card['cvv']} Exp: {card['expiry']}")
        if data.get("error"):
            lines.append(f"Error: {data['error']}")
        return "\n".join(lines)


class Cards402BudgetTool(BaseTool):
    name: str = "cards402_budget"
    description: str = (
        "Check how much this agent has spent and how much budget remains. "
        "Use before ordering to verify you can afford the card."
    )

    def _run(self) -> str:
        resp = httpx.get(f"{BASE_URL}/usage", headers=_headers(), timeout=15)
        if not resp.is_success:
            return f"Error: {resp.status_code}"
        data = resp.json()
        budget = data.get("budget", {})
        orders = data.get("orders", {})
        return (
            f"Spent: ${budget.get('spent_usdc', '?')} / "
            f"Limit: ${budget.get('limit_usdc', 'unlimited')}\n"
            f"Orders: {orders.get('total', 0)} total, "
            f"{orders.get('delivered', 0)} delivered, "
            f"{orders.get('failed', 0)} failed"
        )
