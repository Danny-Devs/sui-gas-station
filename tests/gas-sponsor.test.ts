import { describe, it, expect, beforeEach, vi } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { GasSponsor } from "../src/gas-sponsor.js";
import { GasStationError } from "../src/errors.js";
import {
  mockSuiClient,
  mockSigner,
  makeCoin,
  mockEffects,
  SPONSOR_ADDR,
} from "./helpers.js";

// Valid Sui addresses (32 bytes = 64 hex chars + 0x prefix)
const SENDER = "0x" + "ab".repeat(32);
const RECIPIENT = "0x" + "cd".repeat(32);

describe("GasSponsor", () => {
  let client: ReturnType<typeof mockSuiClient>;
  let signer: ReturnType<typeof mockSigner>;

  beforeEach(() => {
    client = mockSuiClient({
      coins: [
        makeCoin("c1", "500000000"),
        makeCoin("c2", "500000000"),
        makeCoin("c3", "500000000"),
      ],
    });
    signer = mockSigner(SPONSOR_ADDR);
  });

  /**
   * Helper: build transaction kind bytes for a simple MoveCall.
   * Does NOT reference GasCoin — safe for default policy tests.
   */
  async function buildKindBytes(): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.moveCall({ target: "0x2::coin::transfer" });
    return await tx.build({ onlyTransactionKind: true });
  }

  /**
   * Helper: build kind bytes that reference GasCoin (the drain pattern).
   * Used to test that the library rejects this by default.
   */
  async function buildGasCoinKindBytes(): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.transferObjects([tx.splitCoins(tx.gas, [1000n])], RECIPIENT);
    return await tx.build({ onlyTransactionKind: true });
  }

  describe("initialize", () => {
    it("initializes successfully and populates pool", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });

      await sponsor.initialize();

      const stats = sponsor.getStats();
      expect(stats.totalCoins).toBe(3);
      expect(stats.availableCoins).toBe(3);
      expect(stats.sponsorAddress).toBe(SPONSOR_ADDR);
      expect(stats.gasPrice).toBeGreaterThan(0n);
      expect(stats.currentEpoch).toBe("100");
    });
  });

  describe("sponsorTransaction", () => {
    it("throws POOL_NOT_INITIALIZED before initialize()", async () => {
      const sponsor = new GasSponsor({ client, signer });

      await expect(
        sponsor.sponsorTransaction({
          sender: SENDER,
          transactionKindBytes: new Uint8Array([1]),
        }),
      ).rejects.toThrow(GasStationError);

      try {
        await sponsor.sponsorTransaction({
          sender: SENDER,
          transactionKindBytes: new Uint8Array([1]),
        });
      } catch (err) {
        expect((err as GasStationError).code).toBe("POOL_NOT_INITIALIZED");
      }
    });

    it("sponsors a transaction and returns valid result", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      const kindBytes = await buildKindBytes();
      const result = await sponsor.sponsorTransaction({
        sender: SENDER,
        transactionKindBytes: kindBytes,
        gasBudget: 10_000_000n,
      });

      expect(result.transactionBytes).toBeTruthy();
      expect(result.sponsorSignature).toBeTruthy();
      expect(result.gasBudget).toBeGreaterThan(0n);
      expect(result.gasPrice).toBeGreaterThan(0n);
      expect(result.reservation.objectId).toBeTruthy();

      // Signer should have been called to sign
      expect(signer.signTransaction).toHaveBeenCalled();

      // Pool should show one reserved coin
      const stats = sponsor.getStats();
      expect(stats.reservedCoins).toBe(1);
      expect(stats.availableCoins).toBe(2);
    });

    it("throws POOL_EXHAUSTED when no coins available", async () => {
      const singleCoinClient = mockSuiClient({
        coins: [makeCoin("c1", "500000000")],
      });
      const sponsor = new GasSponsor({
        client: singleCoinClient,
        signer,
        targetPoolSize: 1,
      });
      await sponsor.initialize();

      // Reserve the only coin
      const kindBytes = await buildKindBytes();
      await sponsor.sponsorTransaction({
        sender: SENDER,
        transactionKindBytes: kindBytes,
        gasBudget: 10_000_000n,
      });

      // Second request should fail
      await expect(
        sponsor.sponsorTransaction({
          sender: SENDER,
          transactionKindBytes: kindBytes,
          gasBudget: 10_000_000n,
        }),
      ).rejects.toThrow(GasStationError);
    });

    it("enforces policy on requests", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
        policy: { blockedAddresses: ["0x" + "bb".repeat(32)] },
      });
      await sponsor.initialize();

      const kindBytes = await buildKindBytes();
      await expect(
        sponsor.sponsorTransaction({
          sender: "0x" + "bb".repeat(32),
          transactionKindBytes: kindBytes,
          gasBudget: 10_000_000n,
        }),
      ).rejects.toThrow(GasStationError);
    });

    it("allows per-request policy override", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
        // No default policy
      });
      await sponsor.initialize();

      const kindBytes = await buildKindBytes();
      await expect(
        sponsor.sponsorTransaction({
          sender: SENDER,
          transactionKindBytes: kindBytes,
          gasBudget: 10_000_000n,
          policy: { maxBudgetPerTx: 1n }, // Very restrictive override
        }),
      ).rejects.toThrow(GasStationError);
    });

    it("releases coin and throws BUILD_FAILED on invalid kind bytes", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      // Pass invalid kind bytes — should fail during Transaction.fromKind
      try {
        await sponsor.sponsorTransaction({
          sender: SENDER,
          transactionKindBytes: new Uint8Array([0xff, 0xff]),
          gasBudget: 10_000_000n,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GasStationError);
        expect((err as GasStationError).code).toBe("BUILD_FAILED");
        expect((err as GasStationError).message).toContain(
          "Invalid transaction kind bytes",
        );
      }

      // Coin should be released back
      const stats = sponsor.getStats();
      expect(stats.reservedCoins).toBe(0);
      expect(stats.availableCoins).toBe(3);
    });

    it("rejects invalid sender address format", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      const kindBytes = await buildKindBytes();
      await expect(
        sponsor.sponsorTransaction({
          sender: "not_an_address",
          transactionKindBytes: kindBytes,
          gasBudget: 10_000_000n,
        }),
      ).rejects.toThrow(GasStationError);
    });
  });

  describe("reportExecution", () => {
    it("updates pool from effects after successful execution", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      const kindBytes = await buildKindBytes();
      const result = await sponsor.sponsorTransaction({
        sender: SENDER,
        transactionKindBytes: kindBytes,
        gasBudget: 10_000_000n,
      });

      // Simulate successful execution — low gas cost
      const effects = mockEffects(result.reservation.objectId, {
        version: "5",
        computationCost: "5000000",
        storageCost: "2000000",
        storageRebate: "1000000",
      });

      sponsor.reportExecution(result.reservation, effects);

      // Coin should be available again
      const stats = sponsor.getStats();
      expect(stats.reservedCoins).toBe(0);
      expect(stats.availableCoins).toBe(3);
    });

    it("throws INVALID_EFFECTS on invalid effects (missing gasObject)", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      const kindBytes = await buildKindBytes();
      const result = await sponsor.sponsorTransaction({
        sender: SENDER,
        transactionKindBytes: kindBytes,
        gasBudget: 10_000_000n,
      });

      // Pass null/undefined effects — should throw descriptive error
      expect(() =>
        sponsor.reportExecution(
          result.reservation,
          null as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        ),
      ).toThrow(GasStationError);

      try {
        sponsor.reportExecution(
          result.reservation,
          {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        );
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as GasStationError).code).toBe("INVALID_EFFECTS");
        expect((err as GasStationError).message).toContain("showEffects");
      }
    });

    it("removes coin from pool when balance drops too low", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      const kindBytes = await buildKindBytes();
      const result = await sponsor.sponsorTransaction({
        sender: SENDER,
        transactionKindBytes: kindBytes,
        gasBudget: 10_000_000n,
      });

      // Simulate execution that uses almost all the gas
      const effects = mockEffects(result.reservation.objectId, {
        computationCost: "400000000",
        storageCost: "100000000",
        storageRebate: "10000000", // 490M cost, only 10M remaining
      });

      sponsor.reportExecution(result.reservation, effects);

      const stats = sponsor.getStats();
      expect(stats.totalCoins).toBe(2); // One coin removed
    });
  });

  describe("getStats", () => {
    it("returns comprehensive stats", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      const stats = sponsor.getStats();
      expect(stats).toMatchObject({
        sponsorAddress: SPONSOR_ADDR,
        currentEpoch: "100",
      });
      expect(stats.gasPrice).toBeGreaterThan(0n);
      expect(stats.totalCoins).toBeGreaterThan(0);
    });
  });

  describe("replenish", () => {
    it("throws POOL_NOT_INITIALIZED before initialize()", async () => {
      const sponsor = new GasSponsor({ client, signer });

      await expect(sponsor.replenish()).rejects.toThrow(GasStationError);

      try {
        await sponsor.replenish();
      } catch (err) {
        expect((err as GasStationError).code).toBe("POOL_NOT_INITIALIZED");
      }
    });

    it("replenishes pool after initialization", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      // Replenish should succeed (re-fetches and re-populates pool)
      await expect(sponsor.replenish()).resolves.not.toThrow();

      const stats = sponsor.getStats();
      expect(stats.totalCoins).toBeGreaterThan(0);
    });

    it("preserves in-flight reservations during replenish (regression)", async () => {
      // This test proves that replenish() does NOT destroy reserved coin tracking.
      // Previously, replenish() called pool.initialize() which wiped all coins
      // including reserved ones — making reportExecution() silently fail.
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      // Sponsor a transaction — this reserves a coin
      const kindBytes = await buildKindBytes();
      const result = await sponsor.sponsorTransaction({
        sender: SENDER,
        transactionKindBytes: kindBytes,
        gasBudget: 10_000_000n,
      });

      expect(sponsor.getStats().reservedCoins).toBe(1);

      // Replenish while that transaction is in-flight
      await sponsor.replenish();

      // The reserved coin MUST still be tracked
      expect(sponsor.getStats().reservedCoins).toBe(1);

      // reportExecution MUST still work (coin not orphaned)
      const effects = mockEffects(result.reservation.objectId, {
        version: "5",
        computationCost: "5000000",
        storageCost: "2000000",
        storageRebate: "1000000",
      });
      sponsor.reportExecution(result.reservation, effects);

      expect(sponsor.getStats().reservedCoins).toBe(0);
    });
  });

  describe("onPoolDepleted", () => {
    it("fires callback proactively when last coin is taken", async () => {
      const onDepleted = vi.fn();
      const singleCoinClient = mockSuiClient({
        coins: [makeCoin("c1", "500000000")],
      });
      const sponsor = new GasSponsor({
        client: singleCoinClient,
        signer,
        targetPoolSize: 1,
        onPoolDepleted: onDepleted,
      });
      await sponsor.initialize();

      // Reserve the only coin — should fire onPoolDepleted proactively
      const kindBytes = await buildKindBytes();
      await sponsor.sponsorTransaction({
        sender: SENDER,
        transactionKindBytes: kindBytes,
        gasBudget: 10_000_000n,
      });

      // Callback should have fired once already (proactive warning)
      expect(onDepleted).toHaveBeenCalledOnce();
      expect(onDepleted.mock.calls[0][0]).toHaveProperty("totalCoins");

      // Second request fails and fires again
      await expect(
        sponsor.sponsorTransaction({
          sender: SENDER,
          transactionKindBytes: kindBytes,
          gasBudget: 10_000_000n,
        }),
      ).rejects.toThrow(GasStationError);

      expect(onDepleted).toHaveBeenCalledTimes(2);
    });

    it("swallows errors from onPoolDepleted callback", async () => {
      const singleCoinClient = mockSuiClient({
        coins: [makeCoin("c1", "500000000")],
      });
      const sponsor = new GasSponsor({
        client: singleCoinClient,
        signer,
        targetPoolSize: 1,
        onPoolDepleted: () => {
          throw new Error("callback crash");
        },
      });
      await sponsor.initialize();

      const kindBytes = await buildKindBytes();
      await sponsor.sponsorTransaction({
        sender: SENDER,
        transactionKindBytes: kindBytes,
        gasBudget: 10_000_000n,
      });

      // Should throw POOL_EXHAUSTED, not the callback error
      try {
        await sponsor.sponsorTransaction({
          sender: SENDER,
          transactionKindBytes: kindBytes,
          gasBudget: 10_000_000n,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as GasStationError).code).toBe("POOL_EXHAUSTED");
      }
    });
  });

  describe("gas coin drain prevention", () => {
    it("rejects kind bytes that reference GasCoin by default", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      const kindBytes = await buildGasCoinKindBytes();
      try {
        await sponsor.sponsorTransaction({
          sender: SENDER,
          transactionKindBytes: kindBytes,
          gasBudget: 10_000_000n,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GasStationError);
        expect((err as GasStationError).code).toBe("POLICY_VIOLATION");
        expect((err as GasStationError).message).toContain("GasCoin");
      }
    });

    it("allows GasCoin usage when policy permits", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
        policy: { allowGasCoinUsage: true },
      });
      await sponsor.initialize();

      const kindBytes = await buildGasCoinKindBytes();
      const result = await sponsor.sponsorTransaction({
        sender: SENDER,
        transactionKindBytes: kindBytes,
        gasBudget: 10_000_000n,
      });

      expect(result.transactionBytes).toBeTruthy();
      expect(result.sponsorSignature).toBeTruthy();
    });

    it("allows GasCoin via per-request policy override", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
        // No default policy — GasCoin blocked by default
      });
      await sponsor.initialize();

      const kindBytes = await buildGasCoinKindBytes();
      const result = await sponsor.sponsorTransaction({
        sender: SENDER,
        transactionKindBytes: kindBytes,
        gasBudget: 10_000_000n,
        policy: { allowGasCoinUsage: true },
      });

      expect(result.transactionBytes).toBeTruthy();
    });

    it("releases reserved coin when GasCoin check fails", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      const kindBytes = await buildGasCoinKindBytes();
      try {
        await sponsor.sponsorTransaction({
          sender: SENDER,
          transactionKindBytes: kindBytes,
          gasBudget: 10_000_000n,
        });
      } catch {
        // Expected
      }

      // Coin should be released back to the pool
      const stats = sponsor.getStats();
      expect(stats.reservedCoins).toBe(0);
      expect(stats.availableCoins).toBe(3);
    });
  });

  describe("close", () => {
    it("sets initialized to false after close", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      await sponsor.close();

      // After close, sponsoring should throw POOL_NOT_INITIALIZED
      const kindBytes = await buildKindBytes();
      await expect(
        sponsor.sponsorTransaction({
          sender: SENDER,
          transactionKindBytes: kindBytes,
          gasBudget: 10_000_000n,
        }),
      ).rejects.toThrow(GasStationError);
    });
  });

  describe("epoch boundary", () => {
    it("fetches gas price from system state", async () => {
      const sponsor = new GasSponsor({
        client,
        signer,
        targetPoolSize: 3,
      });
      await sponsor.initialize();

      expect(client.getLatestSuiSystemState).toHaveBeenCalled();

      const stats = sponsor.getStats();
      expect(stats.gasPrice).toBe(1000n); // From mock
      expect(stats.currentEpoch).toBe("100");
    });
  });
});
