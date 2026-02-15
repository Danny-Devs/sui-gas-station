# sui-gas-station

Self-hosted gas sponsorship library for Sui. Enable gasless transactions in your dApp — users transact without owning SUI.

Zero runtime dependencies. One peer dependency: `@mysten/sui`.

## Prerequisites

Your sponsor keypair must own at least **10 SUI** — the pool splits it into 20 coins of 0.5 SUI each. On testnet, request SUI from the [faucet](https://docs.sui.io/guides/developer/getting-started/get-coins).

## Quick Start

```typescript
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { GasSponsor } from "sui-gas-station";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io" });
const keypair = Ed25519Keypair.fromSecretKey(process.env.SPONSOR_KEY!);

// 1. Initialize (splits coins into a pool)
const sponsor = new GasSponsor({ client, signer: keypair });
await sponsor.initialize();

// 2. Sponsor a transaction
const result = await sponsor.sponsorTransaction({
  sender: "0xUSER_ADDRESS",
  transactionKindBytes: kindBytes, // see "Client-Side Integration" below
});

// 3. Client executes with dual signatures
const response = await client.executeTransactionBlock({
  transactionBlock: result.transactionBytes,
  signature: [senderSignature, result.sponsorSignature],
  options: { showEffects: true },
});

// 4. Report execution (recycles the gas coin)
sponsor.reportExecution(result.reservation, response.effects!);
```

> **What are `transactionKindBytes`?** The sender builds their Move calls _without_ gas data using `tx.build({ onlyTransactionKind: true })`. Your gas station attaches the gas coin and signs as sponsor. See [Client-Side Integration](#client-side-integration) for the full sender flow.

## How It Works

Sui supports **sponsored transactions** where one address (the sponsor) pays gas on behalf of another (the sender). This requires:

1. The sender builds a **transaction kind** (the operations, without gas data)
2. The sponsor attaches gas data (coin, budget, price) and signs
3. The sender signs the full transaction
4. Both signatures are submitted together

`sui-gas-station` handles step 2 internally — managing a pool of pre-split gas coins, caching gas prices, handling epoch boundaries, and signing as sponsor.

```
Client (sender)                    Your Server (sponsor)
─────────────────                  ─────────────────────
Build tx kind bytes ──────────────→ sponsorTransaction()
                                     ├─ Reserve gas coin
                                     ├─ Attach gas data
                                     ├─ Build full tx
                                     └─ Sign as sponsor
                    ←────────────── { txBytes, sponsorSig }
Sign as sender
Execute with [senderSig, sponsorSig]
                    ──────────────→ reportExecution(effects)
                                     └─ Recycle gas coin
```

## Installation

```bash
npm install sui-gas-station @mysten/sui
```

`@mysten/sui` is a **peer dependency** — you bring your own version (`^1.45.0`).

## API Reference

### `new GasSponsor(options)`

| Option                 | Type              | Default        | Description                            |
| ---------------------- | ----------------- | -------------- | -------------------------------------- |
| `client`               | `SuiClient`       | _required_     | Sui JSON-RPC client                    |
| `signer`               | `Signer`          | _required_     | Sponsor keypair (must own SUI)         |
| `policy`               | `SponsorPolicy`   | —              | Default policy for all requests        |
| `targetPoolSize`       | `number`          | `20`           | Number of gas coins to maintain        |
| `targetCoinBalance`    | `bigint`          | `500_000_000n` | Target balance per coin (0.5 SUI)      |
| `minCoinBalance`       | `bigint`          | `50_000_000n`  | Remove coins below this (0.05 SUI)     |
| `reservationTimeoutMs` | `number`          | `30_000`       | Auto-release reserved coins after this |
| `epochBoundaryWindow`  | `number`          | `1_000`        | Pause near epoch boundaries (ms)       |
| `onPoolDepleted`       | `(stats) => void` | —              | Callback when pool has no coins left   |

### `sponsor.initialize(): Promise<void>`

Fetches existing coins, splits them to target pool size, and caches the current gas price. **Must be called before `sponsorTransaction()`.**

### `sponsor.sponsorTransaction(options): Promise<SponsoredTransaction>`

| Option                 | Type                   | Required | Description                                 |
| ---------------------- | ---------------------- | -------- | ------------------------------------------- |
| `sender`               | `string`               | yes      | Sender's Sui address                        |
| `transactionKindBytes` | `string \| Uint8Array` | yes      | Transaction kind (base64 or bytes)          |
| `gasBudget`            | `bigint`               | no       | Explicit budget (auto-estimated if omitted) |
| `policy`               | `SponsorPolicy`        | no       | Override default policy for this request    |

Returns:

```typescript
{
  transactionBytes: string; // Base64 — full tx ready for sender to sign
  sponsorSignature: string; // Base64 — sponsor's signature
  gasBudget: bigint; // Actual budget (may differ if auto-estimated)
  gasPrice: bigint; // Current reference gas price
  reservation: GasCoinReservation; // Pass to reportExecution()
}
```

### `sponsor.reportExecution(reservation, effects): void`

**Must be called after every sponsored transaction executes, even if the transaction failed on-chain.** The gas coin's version/digest change regardless of transaction success — skipping this call leaves a stale ObjectRef in the pool.

Pass `response.effects` from `executeTransactionBlock({ options: { showEffects: true } })`.

### `sponsor.getStats(): PoolStats`

Returns current pool statistics for monitoring:

```typescript
{
  totalCoins: number;
  availableCoins: number;
  reservedCoins: number;
  totalBalance: bigint;
  sponsorAddress: string;
  currentEpoch: string;
  gasPrice: bigint;
}
```

### `sponsor.replenish(): Promise<void>`

Re-fetches and splits coins to refill the pool. Call from `onPoolDepleted` or on a schedule.

### `sponsor.close(): Promise<void>`

Merges remaining pool coins back into one. Call on graceful shutdown.

## Policy Enforcement

Control who can use your gas station and how much they can spend:

```typescript
const sponsor = new GasSponsor({
  client,
  signer: keypair,
  policy: {
    maxBudgetPerTx: 50_000_000n, // Cap at 0.05 SUI per tx
    blockedAddresses: ["0x..."], // Deny specific addresses
    allowedMoveTargets: [
      "0xpkg::module::function", // Only sponsor these Move calls
    ],
    customValidator: async (sender, kindBytes) => {
      // Your logic: rate limits, auth checks, allowlists, etc.
      return isAllowed(sender);
    },
  },
});
```

Override the default policy per-request:

```typescript
await sponsor.sponsorTransaction({
  sender,
  transactionKindBytes: kindBytes,
  policy: { maxBudgetPerTx: 100_000_000n }, // Higher limit for this request
});
```

## Error Handling

All errors are `GasStationError` instances with typed codes:

```typescript
import { GasStationError } from "sui-gas-station";

try {
  await sponsor.sponsorTransaction({ ... });
} catch (err) {
  if (err instanceof GasStationError) {
    switch (err.code) {
      case "POOL_EXHAUSTED":      // No coins available — retry later
      case "POOL_NOT_INITIALIZED": // Forgot to call initialize()
      case "POLICY_VIOLATION":     // Request rejected by policy
      case "BUILD_FAILED":         // Transaction build/dry-run failed
      case "SIGN_FAILED":          // Sponsor signing failed
    }
  }
}
```

## Architecture

The library has two internal components:

- **`GasSponsor`** — Public API. Handles the sponsorship flow, gas price caching, epoch boundary detection.
- **`CoinPool`** — Internal. Manages a pool of pre-split SUI coins. Handles reservations, timeouts, and effects-based coin recycling (no extra RPC calls).

Key design decisions:

- **Effects-based coin refresh** — After execution, the gas coin's new version/digest comes from `TransactionEffects`, not an extra RPC call. Zero latency, no race conditions.
- **Epoch boundary handling** — Gas price is cached with epoch-aware TTL. Near epoch boundaries, sponsorship pauses briefly to avoid stale gas prices.
- **Reservation timeouts** — Coins auto-release after 30s if `reportExecution()` is never called (crashed clients).
- **Structural typing for effects** — The library accepts any object matching the `ExecutionEffects` shape, compatible with the SDK's `TransactionEffects` type.

## Server Example (Hono)

A complete gas station server in ~30 lines:

```typescript
import { Hono } from "hono";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { GasSponsor, GasStationError } from "sui-gas-station";

const client = new SuiClient({ url: "https://fullnode.testnet.sui.io" });
const keypair = Ed25519Keypair.fromSecretKey(process.env.SPONSOR_KEY!);

const sponsor = new GasSponsor({
  client,
  signer: keypair,
  policy: { maxBudgetPerTx: 50_000_000n },
});
await sponsor.initialize();

const app = new Hono();

app.post("/sponsor", async (c) => {
  const { sender, transactionKindBytes } = await c.req.json();
  try {
    const result = await sponsor.sponsorTransaction({
      sender,
      transactionKindBytes,
    });
    return c.json({
      transactionBytes: result.transactionBytes,
      sponsorSignature: result.sponsorSignature,
      reservation: result.reservation,
    });
  } catch (err) {
    if (err instanceof GasStationError) {
      return c.json({ error: err.code, message: err.message }, 503);
    }
    throw err;
  }
});

app.post("/report", async (c) => {
  const { reservation, effects } = await c.req.json();
  sponsor.reportExecution(reservation, effects);
  return c.json({ ok: true });
});

app.get("/stats", (c) => c.json(sponsor.getStats()));

export default app; // Bun: bun run server.ts | Node: serve with @hono/node-server
```

## Client-Side Integration

The sender (client) builds transaction kind bytes — the operations without any gas data:

```typescript
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";

const tx = new Transaction();
tx.moveCall({ target: "0xpkg::module::function", arguments: [...] });

// Build kind bytes (no gas data)
const kindBytes = await tx.build({ onlyTransactionKind: true });

// Send to your gas station
const res = await fetch("https://your-gas-station.com/sponsor", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sender: myAddress, transactionKindBytes: kindBytes }),
});
const { transactionBytes, sponsorSignature, reservation } = await res.json();

// Sign the full transaction as sender
const { signature } = await keypair.signTransaction(fromBase64(transactionBytes));

// Submit with both signatures
const response = await client.executeTransactionBlock({
  transactionBlock: transactionBytes,
  signature: [signature, sponsorSignature],
  options: { showEffects: true },
});

// Report back so the gas coin gets recycled — MUST be called even if the transaction failed,
// because the gas coin's ObjectRef changes regardless of transaction success/failure.
await fetch("https://your-gas-station.com/report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ reservation, effects: response.effects }),
});
```

`coinWithBalance` and `splitCoins(tx.gas, ...)` both work — they reference the gas coin, which the sponsor provides.

## License

Apache-2.0
