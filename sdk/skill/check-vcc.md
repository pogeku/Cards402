# Check VCC Order

Check the status of a cards402 virtual card order, or get a full spend summary.

## Usage
/check-vcc [order_id|budget]

## Instructions

When invoked with an order ID:

1. Check if `CARDS402_API_KEY` is set. If not, prompt the user to set it.

2. Fetch the order:
   ```typescript
   import { Cards402Client } from 'cards402';

   const client = new Cards402Client({ apiKey: process.env.CARDS402_API_KEY! });
   const order = await client.getOrder('<order_id>');
   ```

3. Interpret `order.phase` and present clearly:
   - `awaiting_payment` — waiting for Stellar payment to arrive
   - `processing` — payment confirmed, card being provisioned
   - `ready` — card is ready (display card details)
   - `failed` — order failed (show `order.error`; mention refund if applicable)
   - `refunded` — refund sent (show `order.refund.stellar_txid`)
   - `expired` — payment window expired, no funds taken

4. If `phase === 'ready'`, display card details:
   ```
   ✅ Virtual Visa Card Ready

   Number: XXXX XXXX XXXX XXXX
   CVV:    XXX
   Expiry: XX/XX
   ```

When invoked with "budget" or no order ID:

```typescript
const usage = await client.getUsage();
```

Display:
```
💳 Budget for <label>:
$<spent> spent of $<limit> limit — $<remaining> remaining

Orders: <total> total
  ✅ <delivered> delivered
  ❌ <failed> failed
  🔄 <refunded> refunded
  ⏳ <in_progress> in progress
```

## Environment variables needed
- `CARDS402_API_KEY` — your cards402 API key
