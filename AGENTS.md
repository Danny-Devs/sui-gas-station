# AGENTS.md — sui-gas-station

Codebase manual for agentic workflows (Claude Code, Codex, Gemini CLI, etc.).

## What This Is

Self-hosted TypeScript gas sponsorship library for Sui. Enables gasless UX — users transact without owning SUI for gas. A sponsor keypair pays gas fees on behalf of senders using Sui's native dual-signature model.

## Commands

```bash
pnpm build              # TypeScript compile (ESM)
pnpm typecheck          # strict mode, no emit
pnpm test               # unit tests (mocked SuiClient)
pnpm test:integration   # E2E against Sui devnet (needs network)
pnpm lint               # oxlint + prettier
pnpm lint:fix           # auto-fix
```

## Architecture

Two classes, one public:

1. **`GasSponsor`** (public) — The only class users interact with
   - `initialize()` → splits coins into pool, caches gas price
   - `sponsorTransaction()` → reserve coin → build tx → sign as sponsor → return bytes+sig
   - `reportExecution()` → parse TransactionEffects, update coin pool (sync, no RPC)
   - `close()` → merge remaining coins
   - `getStats()` → monitoring

2. **`CoinPool`** (internal, not exported) — Manages pre-split gas coins
   - Ported from `ParallelTransactionExecutor` patterns in @mysten/sui
   - Reservation timeout (30s default) prevents coin lockup
   - Effects-based coin refresh (zero extra RPC calls)
   - Epoch boundary detection (1s pause window, matches ParallelTransactionExecutor)

### Key Design Decisions

- **Effects-based coin refresh** — `reportExecution()` reads `effects.gasObject.reference` instead of making an RPC call. Zero latency, no race condition.
- **Epoch boundary handling** — Gas price cached with TTL. On epoch change, sponsorship pauses during boundary window (1s default, 30s max), then pool revalidated.
- **Policy = pure function, not class** — Rate limiting belongs in HTTP server middleware, not the library. Library only validates budget caps, allowlists, blocklists.
- **No GasEstimator class** — SDK's `Transaction.build()` auto-estimates gas. Don't wrap what already works.
- **Typed errors** — `GasStationError` with codes (`POOL_EXHAUSTED`, `EPOCH_BOUNDARY`, etc.) for actionable error handling.

### File Map

| File                 | Lines | Purpose                                    |
| -------------------- | ----- | ------------------------------------------ |
| `src/types.ts`       | ~60   | All TypeScript interfaces                  |
| `src/errors.ts`      | ~30   | GasStationError with typed codes           |
| `src/coin-pool.ts`   | ~300  | Internal coin pool (not exported)          |
| `src/policy.ts`      | ~90   | Policy validation + Move target extraction |
| `src/gas-sponsor.ts` | ~250  | GasSponsor class (the public API)          |
| `src/index.ts`       | ~15   | Public exports barrel                      |

## Dependencies

- `@mysten/sui` (peer dependency, `^1.45.0`) — SuiClient, Transaction, Keypair, types
- Zero runtime dependencies

## Key Patterns

### Dual-Signature Sponsorship Flow

```
Client                    Gas Station                 Sui Network
  │                           │                           │
  ├─ build tx kind bytes ────→│                           │
  │                           ├─ reserve coin             │
  │                           ├─ attach gas data          │
  │                           ├─ sign as sponsor          │
  │←─ txBytes + sponsorSig ──┤                           │
  │                           │                           │
  ├─ sign as sender ─────────────────────────────────────→│
  │  (sends [senderSig, sponsorSig])                     │
  │                           │                           │
  │←─── effects ─────────────────────────────────────────┤│
  ├─ reportExecution ────────→│                           │
  │                           ├─ parse effects            │
  │                           ├─ update coin pool         │
  │                           │                           │
```

### TransactionEffects Parsing

Gas coin ObjectRef changes after every transaction. We read the updated ref from `effects.gasObject.reference`. This avoids an extra `getObject()` RPC call.

### Epoch Boundary

Sui epochs change every ~24h. During the transition, gas prices change and in-flight transactions may fail. We detect epoch changes on gas price cache refresh and pause sponsorship (1s default boundary window, capped at 30s to prevent clock-skew hangs).

### allowedMoveTargets Enforcement

`validatePolicy()` deserializes kind bytes via `Transaction.fromKind()`, iterates commands for `$kind === "MoveCall"`, and reconstructs the target as `${package}::${module}::${function}`. Addresses are normalized to full 64-hex-char form before comparison (so `0x2::coin::transfer` matches the BCS-deserialized `0x000...002::coin::transfer`). `extractMoveTargets()` is also exported for custom validators.

## Gotchas

- **Address normalization** — BCS deserialization returns full-form addresses (`0x000...002`). `allowedMoveTargets` normalizes both sides for comparison. If building custom validators, use `extractMoveTargets()` which returns full-form.
- Coin ObjectRefs (objectId + version + digest) change after EVERY transaction — pool must track this
- Same coin in 2 concurrent transactions = object equivocation = both locked until epoch end
- `Transaction.fromKind()` reconstructs a full Transaction from kind-only bytes
- `Transaction.build({ client })` auto-estimates gas via dry-run when no explicit budget set
- Reservation timeout is critical — if a client crashes after reserving but before reporting, the coin would be locked forever without it

## v2.x Migration Path

This library targets `@mysten/sui ^1.45.0` to integrate with swee-facilitator. Upgrading to `@mysten/sui ^2.0.0` should be straightforward — core APIs (Transaction, SuiClient, Keypair) are similar. When Sui ships the Address Balances feature, `gasMode: 'addressBalance'` may eliminate coin pools entirely.

## Integration Target

Primary consumer: `projects/swee-facilitator/` (x402 payment protocol)

- `TODO(sponsorship)` stubs at `facilitator.ts:16` and `scheme.ts:233`
- `FacilitatorSuiSigner.executeTransaction()` already accepts `string | string[]` for signatures
