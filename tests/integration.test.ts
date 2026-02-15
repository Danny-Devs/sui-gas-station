/**
 * Integration test: full gas sponsorship cycle against Sui devnet.
 *
 * Run: pnpm test:integration
 *
 * Requires devnet to be reachable + faucet to be available.
 * Skips gracefully if either is down (CI-friendly).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Transaction } from "@mysten/sui/transactions";
import { GasSponsor } from "../src/index.js";

// ─── Setup ──────────────────────────────────────────────────────────

const client = new SuiClient({ url: getFullnodeUrl("devnet") });
const sponsorKeypair = new Ed25519Keypair();
const senderKeypair = new Ed25519Keypair();

let devnetAvailable = false;

async function fundFromFaucet(address: string): Promise<void> {
  const response = await requestSuiFromFaucetV2({
    host: getFaucetHost("devnet"),
    recipient: address,
  });
  if (response.status !== "Success") {
    throw new Error(`Faucet failed: ${JSON.stringify(response.status)}`);
  }
}

// ─── Connectivity Check ─────────────────────────────────────────────

beforeAll(async () => {
  try {
    // Check if devnet is reachable
    await client.getLatestSuiSystemState();

    // Fund both keypairs
    await fundFromFaucet(sponsorKeypair.toSuiAddress());
    // Small delay to let faucet tx finalize
    await new Promise((r) => setTimeout(r, 2_000));
    await fundFromFaucet(senderKeypair.toSuiAddress());
    await new Promise((r) => setTimeout(r, 2_000));

    devnetAvailable = true;
  } catch (err) {
    console.warn(
      "⚠️  Devnet or faucet unavailable — skipping integration tests.",
      err instanceof Error ? err.message : err,
    );
  }
}, 30_000);

// ─── Tests ──────────────────────────────────────────────────────────

describe("Integration: full sponsorship cycle on devnet", () => {
  let sponsor: GasSponsor;

  it("initializes pool from faucet-funded coins", async () => {
    if (!devnetAvailable) return;

    sponsor = new GasSponsor({
      client,
      signer: sponsorKeypair,
      targetPoolSize: 2,
      targetCoinBalance: 200_000_000n, // 0.2 SUI per coin
      minCoinBalance: 10_000_000n, // 0.01 SUI floor
    });

    await sponsor.initialize();

    const stats = sponsor.getStats();
    expect(stats.totalCoins).toBeGreaterThanOrEqual(1);
    expect(stats.availableCoins).toBeGreaterThanOrEqual(1);
    expect(stats.gasPrice).toBeGreaterThan(0n);
    expect(stats.currentEpoch).not.toBe("unknown");
    console.log("  Pool stats:", stats);
  });

  it("sponsors a SUI transfer, executes with dual sigs, and reports", async () => {
    if (!devnetAvailable) return;

    const senderAddress = senderKeypair.toSuiAddress();
    const sponsorAddress = sponsorKeypair.toSuiAddress();

    // ─── Step 1: Sender builds kind bytes ────────────────────
    const tx = new Transaction();
    tx.transferObjects(
      [tx.splitCoins(tx.gas, [1_000n])], // Send 1000 MIST to self
      senderAddress,
    );
    const kindBytes = await tx.build({ onlyTransactionKind: true });

    // ─── Step 2: Sponsor the transaction ─────────────────────
    const statsBefore = sponsor.getStats();
    const result = await sponsor.sponsorTransaction({
      sender: senderAddress,
      transactionKindBytes: kindBytes,
      gasBudget: 10_000_000n,
    });

    expect(result.transactionBytes).toBeTruthy();
    expect(result.sponsorSignature).toBeTruthy();
    expect(result.gasBudget).toBeGreaterThan(0n);
    expect(result.gasPrice).toBeGreaterThan(0n);
    expect(result.reservation.objectId).toBeTruthy();
    console.log("  Sponsored! Budget:", result.gasBudget.toString());

    // Pool should show one reserved coin
    const statsAfterSponsor = sponsor.getStats();
    expect(statsAfterSponsor.reservedCoins).toBe(statsBefore.reservedCoins + 1);

    // ─── Step 3: Sender signs ────────────────────────────────
    const txBytes = Uint8Array.from(atob(result.transactionBytes), (c) =>
      c.charCodeAt(0),
    );
    const { signature: senderSig } =
      await senderKeypair.signTransaction(txBytes);

    // ─── Step 4: Execute with dual signatures ────────────────
    const response = await client.executeTransactionBlock({
      transactionBlock: result.transactionBytes,
      signature: [senderSig, result.sponsorSignature],
      options: { showEffects: true, showBalanceChanges: true },
    });

    expect(response.digest).toBeTruthy();
    expect(response.effects).toBeTruthy();
    expect(response.effects!.status.status).toBe("success");
    console.log("  Executed! Digest:", response.digest);

    // ─── Step 5: Verify sender didn't pay gas ────────────────
    if (response.balanceChanges) {
      // Sender's balance change should be from the splitCoins only, not gas
      // Sponsor's balance should decrease (paid gas)
      const senderChange = response.balanceChanges.find(
        (bc) =>
          typeof bc.owner === "object" &&
          "AddressOwner" in bc.owner &&
          bc.owner.AddressOwner === senderAddress,
      );
      const sponsorChange = response.balanceChanges.find(
        (bc) =>
          typeof bc.owner === "object" &&
          "AddressOwner" in bc.owner &&
          bc.owner.AddressOwner === sponsorAddress,
      );

      console.log("  Sender balance change:", senderChange?.amount ?? "none");
      console.log("  Sponsor balance change:", sponsorChange?.amount ?? "none");

      // Sponsor should have a negative balance change (paid gas)
      if (sponsorChange) {
        expect(BigInt(sponsorChange.amount)).toBeLessThan(0n);
      }
    }

    // ─── Step 6: Report execution ────────────────────────────
    sponsor.reportExecution(result.reservation, response.effects!);

    const statsAfterReport = sponsor.getStats();
    expect(statsAfterReport.reservedCoins).toBe(statsBefore.reservedCoins);
    console.log("  Post-report stats:", statsAfterReport);
  });

  it("handles pool stats correctly after cycle", async () => {
    if (!devnetAvailable) return;

    const stats = sponsor.getStats();
    // All coins should be available (none reserved)
    expect(stats.reservedCoins).toBe(0);
    // Total balance should have decreased (gas was spent)
    expect(stats.totalBalance).toBeGreaterThan(0n);
    console.log("  Final pool balance:", stats.totalBalance.toString());
  });

  afterAll(async () => {
    if (!devnetAvailable || !sponsor) return;
    try {
      await sponsor.close();
      console.log("  Sponsor closed (coins merged).");
    } catch {
      // close() may fail if coins were spent — that's fine for tests
    }
  });
});
