/**
 * Policy-enforced gas sponsorship example.
 *
 * Shows how to restrict sponsorship with:
 *   - Per-transaction gas budget caps
 *   - Blocked addresses
 *   - Custom validation logic
 *
 * Usage:
 *   SPONSOR_KEY=<base64-private-key> npx tsx examples/with-policy.ts
 */
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { GasSponsor, GasStationError } from "sui-gas-station";

// ─── Setup ──────────────────────────────────────────────────────────

const client = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl("devnet"),
  network: "devnet",
});

const sponsorKey = process.env.SPONSOR_KEY;
if (!sponsorKey) {
  console.error(
    "Set SPONSOR_KEY env var to a base64-encoded Ed25519 private key",
  );
  process.exit(1);
}
const sponsorKeypair = Ed25519Keypair.fromSecretKey(sponsorKey);
const senderKeypair = new Ed25519Keypair();

// ─── Initialize with default policy ────────────────────────────────

const sponsor = new GasSponsor({
  client,
  signer: sponsorKeypair,
  targetPoolSize: 3,
  policy: {
    // Default policy applied to all requests
    maxBudgetPerTx: 50_000_000n, // Cap at 0.05 SUI per tx

    // Block known bad actors
    blockedAddresses: [
      "0x0000000000000000000000000000000000000000000000000000000000000bad",
    ],

    // This example splits coins from tx.gas, so we opt in to GasCoin usage.
    // In production, only enable this if your use case requires it.
    allowGasCoinUsage: true,

    // Custom validator — e.g., check rate limits, verify user identity
    customValidator: async (sender: string, _kindBytes: Uint8Array) => {
      // In production: check your database, rate limiter, auth token, etc.
      console.log(`  Validating sender: ${sender.slice(0, 10)}...`);
      return true; // Allow for demo
    },
  },
});

await sponsor.initialize();
console.log("Sponsor initialized with policy enforcement\n");

// ─── Example 1: Normal request passes ───────────────────────────────

console.log("--- Example 1: Normal request ---");
const tx = new Transaction();
tx.transferObjects(
  [tx.splitCoins(tx.gas, [1_000n])],
  senderKeypair.toSuiAddress(),
);
const kindBytes = await tx.build({ onlyTransactionKind: true });

try {
  const result = await sponsor.sponsorTransaction({
    sender: senderKeypair.toSuiAddress(),
    transactionKindBytes: kindBytes,
    gasBudget: 10_000_000n,
  });
  console.log("  Sponsored successfully! Budget:", result.gasBudget);

  // Release the coin (we're not actually executing in this demo)
  sponsor.reportExecution(result.reservation, {
    gasObject: {
      reference: {
        objectId: result.reservation.objectId,
        version: "2",
        digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      },
    },
    gasUsed: {
      computationCost: "1000000",
      storageCost: "500000",
      storageRebate: "200000",
    },
  });
} catch (err) {
  console.error("  Failed:", err);
}

// ─── Example 2: Budget too high — rejected ──────────────────────────

console.log("\n--- Example 2: Excessive budget ---");
try {
  await sponsor.sponsorTransaction({
    sender: senderKeypair.toSuiAddress(),
    transactionKindBytes: kindBytes,
    gasBudget: 100_000_000n, // 0.1 SUI — exceeds the 0.05 SUI cap
  });
  console.log("  This should not print!");
} catch (err) {
  if (err instanceof GasStationError) {
    console.log(`  Rejected! Code: ${err.code}, Message: ${err.message}`);
  }
}

// ─── Example 3: Per-request policy override ─────────────────────────

console.log("\n--- Example 3: Per-request policy override ---");
try {
  await sponsor.sponsorTransaction({
    sender: senderKeypair.toSuiAddress(),
    transactionKindBytes: kindBytes,
    gasBudget: 10_000_000n,
    // Override default policy with a very restrictive one
    policy: { maxBudgetPerTx: 1n },
  });
  console.log("  This should not print!");
} catch (err) {
  if (err instanceof GasStationError) {
    console.log(`  Rejected by override! Code: ${err.code}`);
  }
}

console.log("\nFinal stats:", sponsor.getStats());
