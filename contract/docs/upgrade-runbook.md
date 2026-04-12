# Contract upgrade runbook

The Soroban receiver contract at `RECEIVER_CONTRACT_ID` supports admin-gated
upgrades. This doc covers how to upgrade, and how to burn the admin key to
make the contract immutable.

## Who holds the admin key?

The admin key is a Stellar keypair set at deploy time. The public key is
stored on-chain in the contract's instance storage under the `admin` key.
The corresponding secret key is held by the contract deployer (you).

**If you lose the admin secret, you cannot upgrade or modify the contract.**
This is by design — it makes the contract effectively immutable without
needing to burn the key.

## Upgrading the contract

1. Build the new WASM:

   ```
   cd contract
   cargo build --target wasm32-unknown-unknown --release
   ```

2. Upload the new WASM to Stellar:

   ```
   stellar contract install \
     --wasm target/wasm32-unknown-unknown/release/cards402_receiver.wasm \
     --source <ADMIN_SECRET> \
     --network mainnet
   ```

   This returns a `WASM_HASH`.

3. Invoke the upgrade function:

   ```
   stellar contract invoke \
     --id $RECEIVER_CONTRACT_ID \
     --source <ADMIN_SECRET> \
     --network mainnet \
     -- upgrade --new_wasm_hash <WASM_HASH>
   ```

4. Verify:
   ```
   stellar contract invoke --id $RECEIVER_CONTRACT_ID --network mainnet -- version
   ```

## Burning the admin key (making the contract immutable)

If you want to guarantee the contract can never be modified:

```
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <ADMIN_SECRET> \
  --network mainnet \
  -- set_admin --new_admin GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
```

`GAAA...WHF` is the Stellar "zero address" — no one holds its secret key.
After this call, no future `upgrade` or `set_admin` will succeed.

**This is irreversible.** Test thoroughly on testnet before burning mainnet.

## When to burn

Burn the admin key when:

- The contract logic is stable and you don't expect changes
- You want to signal trustlessness to agents (they can verify the WASM
  hash matches the published source and know it can't be swapped)
- You've validated the contract on mainnet for at least a few weeks

Don't burn if:

- You're still iterating on the event schema
- You haven't tested all edge cases (overflow, multi-asset, etc.)
- You want the option to add new payment assets later
