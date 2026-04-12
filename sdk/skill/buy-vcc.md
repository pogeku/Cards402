# Buy VCC

Purchase a prepaid Visa virtual card via cards402.com.

## Usage

/buy-vcc [amount]

## Instructions

When invoked:

1. Check if `CARDS402_API_KEY` and `OWS_WALLET_NAME` are set. If not, explain:
   - `CARDS402_API_KEY` — get one at cards402.com
   - `OWS_WALLET_NAME` — the OWS wallet identifier; run `setup_wallet` (MCP) or:
     ```typescript
     import { createOWSWallet } from 'cards402';
     const { publicKey } = createOWSWallet(process.env.OWS_WALLET_NAME!);
     // Fund publicKey with XLM and USDC, then come back
     ```

2. Ask what amount they want (default $10 if not specified) and whether to pay with USDC or XLM.

3. Before purchasing, check the budget:

   ```typescript
   import { Cards402Client } from 'cards402';
   const client = new Cards402Client({ apiKey: process.env.CARDS402_API_KEY! });
   const usage = await client.getUsage();
   ```

   If `usage.budget.remaining_usdc` is not null and the amount exceeds it, tell the user and stop. Show the current budget.

4. Purchase the card:

   ```typescript
   import { purchaseCardOWS } from 'cards402';

   const card = await purchaseCardOWS({
     apiKey: process.env.CARDS402_API_KEY!,
     walletName: process.env.OWS_WALLET_NAME!,
     passphrase: process.env.OWS_WALLET_PASSPHRASE,
     vaultPath: process.env.OWS_VAULT_PATH,
     amountUsdc: '10.00', // or whatever the user requested
     paymentAsset: 'usdc', // or 'xlm'
   });
   ```

5. Display the card details:

   ```
   ✅ Virtual Visa Card Ready

   Number: XXXX XXXX XXXX XXXX
   CVV:    XXX
   Expiry: XX/XX
   Brand:  Visa

   Order: <order_id>
   ```

6. Report the updated spend summary:

   ```typescript
   const usage = await client.getUsage();
   ```

   ```
   💳 Spend update for <label>:
   $<spent> spent of $<limit> limit — $<remaining> remaining
   Orders: <delivered> delivered, <failed> failed
   ```

   If there is no limit, say "no limit set".

7. Remind the user this is a one-time use virtual card.

## Environment variables needed

- `CARDS402_API_KEY` — your cards402 API key (get one at cards402.com)
- `OWS_WALLET_NAME` — OWS wallet identifier (must be funded with USDC or XLM)
- `OWS_WALLET_PASSPHRASE` — wallet encryption passphrase (optional)
- `OWS_VAULT_PATH` — vault file path (optional, default: `~/.ows/vault`)
