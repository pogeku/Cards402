#!/usr/bin/env python3
"""
cards402 Python agent example — order a virtual Visa card via the REST API.

Prerequisites:
  pip install httpx
  export CARDS402_API_KEY=<your key>

This example uses the REST API directly (no SDK). For the full payment flow
you'd also need to invoke the Soroban contract from Python (e.g. via
stellar-sdk). This example assumes you're using the webhook delivery path
where cards402 POSTs the card to your webhook_url once it's ready.

Run:
  python main.py
"""

import os
import sys
import time
import httpx

API_KEY = os.environ.get("CARDS402_API_KEY")
BASE_URL = os.environ.get("CARDS402_BASE_URL", "https://api.cards402.com/v1")

if not API_KEY:
    print("Set CARDS402_API_KEY in your environment", file=sys.stderr)
    sys.exit(1)

HEADERS = {"X-Api-Key": API_KEY, "Content-Type": "application/json"}


def create_order(amount_usdc: str = "2.00") -> dict:
    """Create a new card order. Returns payment instructions."""
    resp = httpx.post(
        f"{BASE_URL}/orders",
        headers=HEADERS,
        json={"amount_usdc": amount_usdc},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def get_order(order_id: str) -> dict:
    """Poll order status."""
    resp = httpx.get(
        f"{BASE_URL}/orders/{order_id}",
        headers=HEADERS,
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def wait_for_card(order_id: str, timeout_s: int = 300, interval_s: int = 3) -> dict:
    """Poll until the card is ready or the order fails."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        order = get_order(order_id)
        phase = order.get("phase")
        print(f"  [{order_id[:8]}] phase={phase}")

        if phase == "ready" and "card" in order:
            return order["card"]
        if phase in ("failed", "refunded", "rejected", "expired"):
            raise RuntimeError(f"Order {phase}: {order.get('error', 'unknown')}")

        time.sleep(interval_s)

    raise TimeoutError(f"Order {order_id} did not complete within {timeout_s}s")


def check_budget() -> dict:
    """Get the agent's spend summary."""
    resp = httpx.get(f"{BASE_URL}/usage", headers=HEADERS, timeout=15)
    resp.raise_for_status()
    return resp.json()


def main():
    # Check budget first
    usage = check_budget()
    budget = usage.get("budget", {})
    print(f"Budget: spent ${budget.get('spent_usdc', '?')}", end="")
    if budget.get("limit_usdc"):
        print(f" / limit ${budget['limit_usdc']}", end="")
    print()

    # Create order
    print("\nCreating $2.00 order...")
    order = create_order("2.00")
    order_id = order["order_id"]
    print(f"Order {order_id} created (phase: {order.get('phase')})")

    # Show payment instructions
    payment = order.get("payment", {})
    if payment.get("type") == "soroban_contract":
        print(f"\nPay the Soroban contract:")
        print(f"  Contract: {payment['contract_id']}")
        print(f"  USDC:     {payment['usdc']['amount']} ({payment['usdc']['asset']})")
        if "xlm" in payment:
            print(f"  XLM:      {payment['xlm']['amount']}")
        print(f"  Order ID: {payment['order_id']} (pass as arg to pay_usdc/pay_xlm)")
        print()

    # In a real agent you'd pay the contract here using stellar-sdk.
    # For this example, we just poll — if you've already paid via another
    # tool (like the MCP server), this will pick up the result.
    print("Waiting for card (pay the contract to proceed)...")
    try:
        card = wait_for_card(order_id)
        print(f"\nCard delivered!")
        print(f"  Number: {card['number']}")
        print(f"  CVV:    {card['cvv']}")
        print(f"  Expiry: {card['expiry']}")
        print(f"  Brand:  {card.get('brand', 'Visa')}")
    except (RuntimeError, TimeoutError) as e:
        print(f"\n{e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
