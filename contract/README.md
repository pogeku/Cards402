# Cards402 Receiver Contract

Soroban smart contract that receives USDC payments from AI agents and emits `payment` events containing the order ID. The backend polls these events to route and fulfil orders — no memo or destination matching required.

## Environment variables

| Variable               | Description                                                          |
| ---------------------- | -------------------------------------------------------------------- |
| `RECEIVER_CONTRACT_ID` | Deployed contract address (C...)                                     |
| `SOROBAN_RPC_URL`      | Soroban RPC endpoint (optional — defaults to public mainnet/testnet) |

## Deployment steps

### 1. Install toolchain

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked stellar-cli
```

### 2. Build

```bash
cargo build --target wasm32-unknown-unknown --release
```

### 3. Optimise

```bash
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/cards402_receiver.wasm
```

This produces `cards402_receiver.optimized.wasm`.

### 4. Deploy to testnet

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/cards402_receiver.optimized.wasm \
  --source <YOUR_SECRET_KEY> \
  --network testnet
```

For mainnet replace `--network testnet` with `--network mainnet`.

The command prints the deployed contract ID (C...). Save it as `RECEIVER_CONTRACT_ID`.

### 5. Deploy to mainnet

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/cards402_receiver.optimized.wasm \
  --source <YOUR_SECRET_KEY> \
  --network mainnet
```

### 6. Initialise

Call `init` **once** after deployment. `init` stores the admin, treasury, and
asset contract addresses and requires the admin signature. Calling `init` a
second time panics with `already initialized`.

The contract retains an `upgrade(new_wasm_hash)` entrypoint gated by
`admin.require_auth()` — the admin key can swap the contract's WASM in the
future. There is no pause function; if you want a fully immutable deployment,
transfer the admin key to a burn address after `init` (or fork the contract
with `upgrade` removed).

Contract IDs on Stellar mainnet:

- USDC SAC: `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
- XLM native SAC: `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA`

```bash
stellar contract invoke \
  --id <RECEIVER_CONTRACT_ID> \
  --source <ADMIN_SECRET_KEY> \
  --network mainnet \
  -- init \
  --admin G... \
  --treasury G... \
  --usdc_contract CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75 \
  --xlm_contract CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA
```

- `--admin`: account that authorizes `init` and any future `upgrade` call
- `--treasury`: Stellar address that receives all USDC and XLM payments
- `--usdc_contract`: USDC SAC contract on the target network
- `--xlm_contract`: native XLM SAC contract on the target network

## Event schema

Each successful payment emits one Soroban event. The `topic[0]` symbol identifies the asset.

### USDC payment (`pay_usdc`)

| Field      | Type      | Value                                   |
| ---------- | --------- | --------------------------------------- |
| `topic[0]` | `Symbol`  | `"pay_usdc"`                            |
| `topic[1]` | `Bytes`   | UTF-8 encoded order UUID                |
| `topic[2]` | `Address` | Sender's Stellar address                |
| `value`    | `i128`    | Amount in stroops (1 USDC = 10,000,000) |

### XLM payment (`pay_xlm`)

| Field      | Type      | Value                                  |
| ---------- | --------- | -------------------------------------- |
| `topic[0]` | `Symbol`  | `"pay_xlm"`                            |
| `topic[1]` | `Bytes`   | UTF-8 encoded order UUID               |
| `topic[2]` | `Address` | Sender's Stellar address               |
| `value`    | `i128`    | Amount in stroops (1 XLM = 10,000,000) |

The backend event watcher filters on both `pay_usdc` and `pay_xlm` symbols.
