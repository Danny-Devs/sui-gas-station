/**
 * Basic gas sponsorship example.
 *
 * Demonstrates the minimal flow:
 *   1. Initialize a GasSponsor with a funded keypair
 *   2. Sponsor a transaction (from kind bytes)
 *   3. Execute with dual signatures (sender + sponsor)
 *   4. Report execution to recycle the gas coin
 *
 * Usage:
 *   SPONSOR_KEY=<base64-private-key> npx tsx examples/basic-sponsorship.ts
 *
 * Prerequisites:
 *   - A funded Sui keypair (sponsor) — needs SUI for gas
 *   - A second keypair (sender) — the gasless user
 */
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { GasSponsor } from "sui-gas-station";

// ─── Setup ──────────────────────────────────────────────────────────

const client = new SuiClient({ url: getFullnodeUrl("devnet") });

// Sponsor keypair — owns the gas coins
const sponsorKey = process.env.SPONSOR_KEY;
if (!sponsorKey) {
  console.error(
    "Set SPONSOR_KEY env var to a base64-encoded Ed25519 private key",
  );
  process.exit(1);
}
const sponsorKeypair = Ed25519Keypair.fromSecretKey(sponsorKey);

// Sender keypair — the "gasless" user
const senderKeypair = new Ed25519Keypair();

console.log("Sponsor:", sponsorKeypair.toSuiAddress());
console.log("Sender: ", senderKeypair.toSuiAddress());

// ─── Initialize ─────────────────────────────────────────────────────

const sponsor = new GasSponsor({
  client,
  signer: sponsorKeypair,
  targetPoolSize: 3, // Split into 3 gas coins
  targetCoinBalance: 500_000_000n, // 0.5 SUI each
});

await sponsor.initialize();
console.log("Pool initialized:", sponsor.getStats());

// ─── Build transaction kind bytes (client-side) ─────────────────────

// In a real app, the sender builds these and sends them to your server.
const tx = new Transaction();
tx.transferObjects(
  [tx.splitCoins(tx.gas, [1_000n])],
  senderKeypair.toSuiAddress(), // Send 1000 MIST to self (demo)
);
const kindBytes = await tx.build({ onlyTransactionKind: true });

// ─── Sponsor the transaction (server-side) ──────────────────────────

const result = await sponsor.sponsorTransaction({
  sender: senderKeypair.toSuiAddress(),
  transactionKindBytes: kindBytes,
  gasBudget: 10_000_000n, // 0.01 SUI
  // This demo uses splitCoins(tx.gas) which requires opting in per-request.
  // Most production transactions (MoveCall, etc.) don't need this.
  policy: { allowGasCoinUsage: true },
});

console.log(
  "Sponsored! Budget:",
  result.gasBudget,
  "Gas price:",
  result.gasPrice,
);

// ─── Execute with dual signatures ───────────────────────────────────

// Sender signs the same transaction bytes
const { signature: senderSig } = await senderKeypair.signTransaction(
  fromBase64(result.transactionBytes),
);

// Submit with both signatures
const response = await client.executeTransactionBlock({
  transactionBlock: result.transactionBytes,
  signature: [senderSig, result.sponsorSignature],
  options: { showEffects: true },
});

console.log("Executed! Digest:", response.digest);

// ─── Report execution (recycle the gas coin) ────────────────────────

sponsor.reportExecution(result.reservation, response.effects!);

console.log("Post-execution stats:", sponsor.getStats());
console.log("Done! Sender paid zero gas.");
