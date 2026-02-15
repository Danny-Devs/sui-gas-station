import { describe, it, expect, beforeEach } from "vitest";
import { CoinPool } from "../src/coin-pool.js";
import {
  makeCoin,
  mockSuiClient,
  mockSigner,
  mockEffects,
  objectId,
} from "./helpers.js";

describe("CoinPool", () => {
  let pool: CoinPool;

  beforeEach(() => {
    pool = new CoinPool({
      targetPoolSize: 3,
      targetCoinBalance: 500_000_000n,
      minCoinBalance: 50_000_000n,
      reservationTimeoutMs: 5_000,
    });
  });

  describe("initialize", () => {
    it("populates pool from existing right-sized coins", async () => {
      const client = mockSuiClient({
        coins: [
          makeCoin("c1", "500000000"),
          makeCoin("c2", "500000000"),
          makeCoin("c3", "500000000"),
        ],
      });
      const signer = mockSigner();

      await pool.initialize(client, signer);

      const stats = pool.getStats();
      expect(stats.total).toBe(3);
      expect(stats.available).toBe(3);
      expect(stats.reserved).toBe(0);
    });

    it("splits large coins when not enough right-sized ones exist", async () => {
      const client = mockSuiClient({
        coins: [makeCoin("b1", "5000000000")], // 5 SUI — too large, needs splitting
      });
      const signer = mockSigner();

      await pool.initialize(client, signer);

      // Should have called executeTransactionBlock for splitting
      expect(client.executeTransactionBlock).toHaveBeenCalled();
    });

    it("clears existing state on re-initialization", async () => {
      const client = mockSuiClient({
        coins: [makeCoin("c1", "500000000"), makeCoin("c2", "500000000")],
      });
      const signer = mockSigner();

      await pool.initialize(client, signer);
      expect(pool.getStats().total).toBe(2);

      // Re-initialize — should start fresh
      const client2 = mockSuiClient({
        coins: [makeCoin("d1", "500000000")],
      });
      await pool.initialize(client2, signer);
      expect(pool.getStats().total).toBe(1);
    });

    it("ignores dust coins below min balance", async () => {
      const client = mockSuiClient({
        coins: [
          makeCoin("dust", "1000"), // below 50M MIST min
          makeCoin("ok1", "500000000"),
        ],
      });
      const signer = mockSigner();

      await pool.initialize(client, signer);

      const stats = pool.getStats();
      expect(stats.total).toBe(1);
    });
  });

  describe("reserve / release", () => {
    beforeEach(async () => {
      const client = mockSuiClient({
        coins: [
          makeCoin("c1", "500000000"),
          makeCoin("c2", "500000000"),
          makeCoin("c3", "500000000"),
        ],
      });
      await pool.initialize(client, mockSigner());
    });

    it("reserves an available coin", () => {
      const coin = pool.reserve();
      expect(coin).not.toBeNull();
      expect(coin!.status).toBe("reserved");

      const stats = pool.getStats();
      expect(stats.available).toBe(2);
      expect(stats.reserved).toBe(1);
    });

    it("releases a reserved coin back to available", () => {
      const coin = pool.reserve()!;
      pool.release(coin.objectId);

      const stats = pool.getStats();
      expect(stats.available).toBe(3);
      expect(stats.reserved).toBe(0);
    });

    it("returns null when all coins are reserved", () => {
      pool.reserve();
      pool.reserve();
      pool.reserve();

      const result = pool.reserve();
      expect(result).toBeNull();
    });

    it("respects minimum balance requirement", () => {
      const result = pool.reserve(999_999_999_999n);
      expect(result).toBeNull();
    });

    it("returns a snapshot copy, not a mutable reference", () => {
      const coin = pool.reserve()!;
      // Modifying the returned coin should NOT affect the pool's internal state
      const originalId = coin.objectId;
      coin.objectId = "0xhacked";

      // Release using the original ID — pool should still find it
      pool.release(originalId);
      const stats = pool.getStats();
      expect(stats.available).toBe(3);
    });
  });

  describe("updateFromEffects", () => {
    const coinId = objectId("c1");

    beforeEach(async () => {
      const client = mockSuiClient({
        coins: [makeCoin("c1", "500000000")],
      });
      await pool.initialize(client, mockSigner());
    });

    it("updates coin version and digest from effects", () => {
      const coin = pool.reserve()!;
      const effects = mockEffects(coinId, {
        version: "5",
        digest: "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY",
        computationCost: "1000000",
        storageCost: "500000",
        storageRebate: "200000",
      });

      pool.updateFromEffects(effects, coin.objectId);

      const stats = pool.getStats();
      expect(stats.available).toBe(1);
      expect(stats.reserved).toBe(0);
    });

    it("removes coin from pool if balance drops below minimum", () => {
      const coin = pool.reserve()!;
      const effects = mockEffects(coinId, {
        computationCost: "400000000",
        storageCost: "100000000",
        storageRebate: "10000000", // Net: 490M, remaining: 10M < 50M min
      });

      pool.updateFromEffects(effects, coin.objectId);

      const stats = pool.getStats();
      expect(stats.total).toBe(0);
    });

    it("removes coin when gas cost exceeds tracked balance", () => {
      const coin = pool.reserve()!;
      // Gas cost greater than coin balance — remaining clamped to 0
      const effects = mockEffects(coinId, {
        computationCost: "600000000",
        storageCost: "100000000",
        storageRebate: "10000000", // Net: 690M > 500M balance
      });

      pool.updateFromEffects(effects, coin.objectId);

      const stats = pool.getStats();
      expect(stats.total).toBe(0); // Removed, not negative balance
    });

    it("keeps coin if remaining balance is above minimum", () => {
      const coin = pool.reserve()!;
      const effects = mockEffects(coinId, {
        computationCost: "5000000",
        storageCost: "2000000",
        storageRebate: "1000000", // Net: 6M, remaining: 494M
      });

      pool.updateFromEffects(effects, coin.objectId);

      const stats = pool.getStats();
      expect(stats.total).toBe(1);
      expect(stats.totalBalance).toBe(494_000_000n);
    });

    it("includes nonRefundableStorageFee in gas calculation", () => {
      const coin = pool.reserve()!;
      // Without nonRefundableStorageFee: totalGas = 5M + 2M - 1M = 6M, remaining = 494M
      // With nonRefundableStorageFee=10000: totalGas = 5M + 2M - 1M + 10K = 6.01M, remaining = 493.99M
      const effects = mockEffects(coinId, {
        computationCost: "5000000",
        storageCost: "2000000",
        storageRebate: "1000000",
        nonRefundableStorageFee: "10000",
      });

      pool.updateFromEffects(effects, coin.objectId);

      const stats = pool.getStats();
      expect(stats.total).toBe(1);
      expect(stats.totalBalance).toBe(493_990_000n); // 500M - 6.01M
    });

    it("deletes coin when effects objectId doesn't match (misrouted effects)", () => {
      const coin = pool.reserve()!;
      // Effects reference a different gas coin objectId — stale/wrong effects
      const wrongEffects = mockEffects(objectId("ff"), {
        computationCost: "1000",
        storageCost: "1000",
        storageRebate: "500",
      });

      pool.updateFromEffects(wrongEffects, coin.objectId);

      const stats = pool.getStats();
      expect(stats.total).toBe(0); // Removed — on-chain state unknown
    });
  });

  describe("recycleExpired", () => {
    beforeEach(async () => {
      const client = mockSuiClient({
        coins: [makeCoin("c1", "500000000"), makeCoin("c2", "500000000")],
      });
      pool = new CoinPool({
        targetPoolSize: 2,
        reservationTimeoutMs: 1_000,
      });
      await pool.initialize(client, mockSigner());
    });

    it("deletes expired reservations (prevents stale ObjectRef reuse)", () => {
      const coin = pool.reserve()!;
      expect(coin).not.toBeNull();

      const expired = pool.recycleExpired(Date.now() + 2_000);
      expect(expired).toContain(coin.objectId);

      // Expired coins are DELETED, not recycled — prevents equivocation
      const stats = pool.getStats();
      expect(stats.available).toBe(1); // Only the unreserved coin remains
      expect(stats.reserved).toBe(0);
      expect(stats.total).toBe(1); // Down from 2
    });

    it("does not release fresh reservations", () => {
      pool.reserve();
      const expired = pool.recycleExpired(Date.now());
      expect(expired).toHaveLength(0);

      const stats = pool.getStats();
      expect(stats.reserved).toBe(1);
    });
  });

  describe("revalidatePool", () => {
    it("updates coin refs from network", async () => {
      const client = mockSuiClient({
        coins: [makeCoin("c1", "500000000")],
      });
      await pool.initialize(client, mockSigner());

      client.multiGetObjects.mockResolvedValueOnce([
        {
          data: {
            objectId: objectId("c1"),
            version: "99",
            digest: "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq",
            content: {
              dataType: "moveObject",
              fields: { balance: "490000000" },
            },
          },
        },
      ]);

      await pool.revalidatePool(client);

      const stats = pool.getStats();
      expect(stats.total).toBe(1);
    });

    it("removes coins that no longer exist", async () => {
      const client = mockSuiClient({
        coins: [makeCoin("c1", "500000000")],
      });
      await pool.initialize(client, mockSigner());

      client.multiGetObjects.mockResolvedValueOnce([
        { data: null, error: { code: "notExists", object_id: objectId("c1") } },
      ]);

      await pool.revalidatePool(client);

      const stats = pool.getStats();
      expect(stats.total).toBe(0);
    });

    it("skips reserved coins (preserves in-flight transaction refs)", async () => {
      const client = mockSuiClient({
        coins: [makeCoin("c1", "500000000"), makeCoin("c2", "500000000")],
      });
      pool = new CoinPool({ targetPoolSize: 2 });
      await pool.initialize(client, mockSigner());

      // Reserve c1 — simulates an in-flight transaction
      const reserved = pool.reserve()!;
      expect(reserved).not.toBeNull();

      // Revalidate returns new versions for both coins
      client.multiGetObjects.mockResolvedValueOnce([
        {
          data: {
            objectId: reserved.objectId,
            version: "99",
            digest: "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq",
            content: {
              dataType: "moveObject",
              fields: { balance: "490000000" },
            },
          },
        },
        {
          data: {
            objectId: objectId("c2"),
            version: "99",
            digest: "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY",
            content: {
              dataType: "moveObject",
              fields: { balance: "490000000" },
            },
          },
        },
      ]);

      await pool.revalidatePool(client);

      // c2 (available) should have updated version
      // c1 (reserved) should still have original version "1"
      // We can verify by releasing c1 and checking pool balance reflects
      // the un-updated version (c1 still at 500M, c2 updated to 490M)
      const stats = pool.getStats();
      expect(stats.total).toBe(2);
      expect(stats.totalBalance).toBe(990_000_000n); // c1=500M (skipped) + c2=490M (updated)
    });
  });

  describe("replenish", () => {
    it("preserves reserved coins while adding new ones", async () => {
      const client = mockSuiClient({
        coins: [makeCoin("c1", "500000000"), makeCoin("c2", "500000000")],
      });
      pool = new CoinPool({ targetPoolSize: 3, reservationTimeoutMs: 30_000 });
      await pool.initialize(client, mockSigner());

      // Reserve c1 — simulates an in-flight transaction
      const reserved = pool.reserve()!;
      expect(reserved).not.toBeNull();
      expect(pool.getStats().reserved).toBe(1);
      expect(pool.getStats().available).toBe(1);

      // Replenish — should add new coins WITHOUT clearing reserved c1
      client.getCoins.mockResolvedValueOnce({
        data: [
          makeCoin("c1", "500000000"), // already tracked (reserved)
          makeCoin("c2", "500000000"), // already tracked (available)
          makeCoin("n1", "500000000"), // new coin
        ],
        nextCursor: null,
        hasNextPage: false,
      });

      await pool.replenish(client, mockSigner());

      const stats = pool.getStats();
      expect(stats.total).toBe(3); // c1 + c2 + n1
      expect(stats.reserved).toBe(1); // c1 still reserved
      expect(stats.available).toBe(2); // c2 + n1
    });

    it("does not add coins when pool is already full", async () => {
      const client = mockSuiClient({
        coins: [
          makeCoin("c1", "500000000"),
          makeCoin("c2", "500000000"),
          makeCoin("c3", "500000000"),
        ],
      });
      pool = new CoinPool({ targetPoolSize: 3 });
      await pool.initialize(client, mockSigner());
      expect(pool.getStats().total).toBe(3);

      await pool.replenish(client, mockSigner());
      expect(pool.getStats().total).toBe(3); // No change
    });

    it("reportExecution works on reserved coins after replenish", async () => {
      const client = mockSuiClient({
        coins: [makeCoin("c1", "500000000")],
      });
      pool = new CoinPool({
        targetPoolSize: 2,
        minCoinBalance: 50_000_000n,
        reservationTimeoutMs: 30_000,
      });
      await pool.initialize(client, mockSigner());

      // Reserve c1
      const reserved = pool.reserve()!;
      expect(reserved).not.toBeNull();

      // Replenish — c1 should remain tracked as reserved
      client.getCoins.mockResolvedValueOnce({
        data: [makeCoin("c1", "500000000"), makeCoin("n1", "500000000")],
        nextCursor: null,
        hasNextPage: false,
      });
      await pool.replenish(client, mockSigner());

      // Now report execution on c1 — this MUST succeed (coin still tracked)
      const effects = mockEffects(reserved.objectId, {
        version: "5",
        computationCost: "5000000",
        storageCost: "2000000",
        storageRebate: "1000000",
      });
      pool.updateFromEffects(effects, reserved.objectId);

      const stats = pool.getStats();
      expect(stats.reserved).toBe(0); // c1 recycled back to available
      expect(stats.available).toBe(2); // c1 + n1 both available
    });
  });
});
