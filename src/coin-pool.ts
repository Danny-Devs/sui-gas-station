// Copyright (c) Danny Devs
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal coin pool for gas sponsorship.
 * NOT exported from the public API — used only by GasSponsor.
 *
 * Ported from ParallelTransactionExecutor patterns in @mysten/sui SDK.
 * Key insight: after execution, we update coin refs from the JSON-RPC
 * effects response (gasObject.reference) — zero extra RPC calls.
 */
import type { SuiClient } from "@mysten/sui/client";
import type { Signer } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import type { CoinEntry, ExecutionEffects } from "./types.js";

// ─── Defaults (matching ParallelTransactionExecutor) ────────────────

const DEFAULT_TARGET_POOL_SIZE = 20;
const DEFAULT_TARGET_COIN_BALANCE = 500_000_000n; // 0.5 SUI
const DEFAULT_MIN_COIN_BALANCE = 50_000_000n; // 0.05 SUI
const DEFAULT_RESERVATION_TIMEOUT_MS = 30_000; // 30 seconds

// ─── CoinPool ───────────────────────────────────────────────────────

export interface CoinPoolOptions {
  targetPoolSize?: number;
  targetCoinBalance?: bigint;
  minCoinBalance?: bigint;
  reservationTimeoutMs?: number;
}

export class CoinPool {
  private coins = new Map<string, CoinEntry>();
  private readonly targetPoolSize: number;
  private readonly targetCoinBalance: bigint;
  private readonly minCoinBalance: bigint;
  private readonly reservationTimeoutMs: number;

  constructor(options: CoinPoolOptions = {}) {
    this.targetPoolSize = options.targetPoolSize ?? DEFAULT_TARGET_POOL_SIZE;
    this.targetCoinBalance =
      options.targetCoinBalance ?? DEFAULT_TARGET_COIN_BALANCE;
    this.minCoinBalance = options.minCoinBalance ?? DEFAULT_MIN_COIN_BALANCE;
    this.reservationTimeoutMs =
      options.reservationTimeoutMs ?? DEFAULT_RESERVATION_TIMEOUT_MS;
  }

  /**
   * Query sponsor's coins and split into pool-sized pieces.
   * If sponsor already has enough small coins, skips splitting.
   *
   * WARNING: Clears ALL pool state including reserved coins.
   * Do NOT call while transactions are in-flight — use replenish() instead.
   */
  async initialize(client: SuiClient, signer: Signer): Promise<void> {
    this.coins.clear();
    const address = signer.toSuiAddress();
    const existingCoins = await this.fetchAllCoins(client, address);

    // Separate coins into usable (right-sized) and source (need splitting)
    const usable: Array<{
      objectId: string;
      version: string;
      digest: string;
      balance: bigint;
    }> = [];
    const sourceRefs: Array<{
      objectId: string;
      version: string;
      digest: string;
    }> = [];

    for (const coin of existingCoins) {
      const balance = BigInt(coin.balance);
      if (
        balance >= this.minCoinBalance &&
        balance <= this.targetCoinBalance * 2n
      ) {
        usable.push({
          objectId: coin.coinObjectId,
          version: coin.version,
          digest: coin.digest,
          balance,
        });
      } else if (balance > this.targetCoinBalance * 2n) {
        sourceRefs.push({
          objectId: coin.coinObjectId,
          version: coin.version,
          digest: coin.digest,
        });
      }
      // Coins below minCoinBalance are ignored (dust)
    }

    // Add usable coins to pool (up to target size)
    for (const coin of usable.slice(0, this.targetPoolSize)) {
      this.coins.set(coin.objectId, {
        ...coin,
        status: "available",
        reservedAt: null,
      });
    }

    // If we need more coins, split from source coins
    const needed = this.targetPoolSize - this.coins.size;
    if (needed > 0 && sourceRefs.length > 0) {
      await this.splitCoins(client, signer, sourceRefs, needed);
    }
  }

  /**
   * Add new coins to the pool without disturbing existing entries.
   * Safe to call while transactions are in-flight — reserved coins are untouched.
   *
   * Fetches all coins from the network, skips any already tracked (by objectId),
   * and adds new ones up to targetPoolSize. Splits large coins if needed.
   */
  async replenish(client: SuiClient, signer: Signer): Promise<void> {
    const address = signer.toSuiAddress();
    const existingCoins = await this.fetchAllCoins(client, address);

    const trackedIds = new Set(this.coins.keys());
    const needed = this.targetPoolSize - this.coins.size;
    if (needed <= 0) return;

    const usable: Array<{
      objectId: string;
      version: string;
      digest: string;
      balance: bigint;
    }> = [];
    const sourceRefs: Array<{
      objectId: string;
      version: string;
      digest: string;
    }> = [];

    for (const coin of existingCoins) {
      if (trackedIds.has(coin.coinObjectId)) continue;

      const balance = BigInt(coin.balance);
      if (
        balance >= this.minCoinBalance &&
        balance <= this.targetCoinBalance * 2n
      ) {
        usable.push({
          objectId: coin.coinObjectId,
          version: coin.version,
          digest: coin.digest,
          balance,
        });
      } else if (balance > this.targetCoinBalance * 2n) {
        sourceRefs.push({
          objectId: coin.coinObjectId,
          version: coin.version,
          digest: coin.digest,
        });
      }
    }

    let added = 0;
    for (const coin of usable) {
      if (added >= needed) break;
      this.coins.set(coin.objectId, {
        ...coin,
        status: "available",
        reservedAt: null,
      });
      added++;
    }

    const stillNeeded = needed - added;
    if (stillNeeded > 0 && sourceRefs.length > 0) {
      await this.splitCoins(client, signer, sourceRefs, stillNeeded);
    }
  }

  /**
   * Reserve an available coin with sufficient balance.
   * Returns null if no coins available (caller should throw POOL_EXHAUSTED).
   */
  reserve(minBalance?: bigint): CoinEntry | null {
    // First, recycle any expired reservations
    this.recycleExpired(Date.now());

    const required = minBalance ?? this.minCoinBalance;
    for (const [, coin] of this.coins) {
      if (coin.status === "available" && coin.balance >= required) {
        coin.status = "reserved";
        coin.reservedAt = Date.now();
        // Return a snapshot — caller gets a frozen view of the coin state
        // at reservation time. The pool's internal copy may change later
        // (e.g., during recycleExpired or revalidatePool).
        return { ...coin };
      }
    }
    return null;
  }

  /**
   * Release a reserved coin back to the pool.
   */
  release(objectId: string): void {
    const coin = this.coins.get(objectId);
    if (coin && coin.status === "reserved") {
      coin.status = "available";
      coin.reservedAt = null;
    }
  }

  /**
   * Update a coin's ObjectRef from execution effects.
   * The gas coin's version and digest change after every transaction.
   * We read the new values from the effects response — zero RPC calls.
   */
  updateFromEffects(effects: ExecutionEffects, objectId: string): void {
    const coin = this.coins.get(objectId);
    if (!coin) return;

    const gasRef = effects.gasObject.reference;

    // Safety check: if the effects' gas coin objectId doesn't match the
    // coin we reserved, the effects don't belong to this coin. Remove
    // the stale entry — its on-chain state is unknown.
    if (gasRef.objectId !== objectId) {
      this.coins.delete(objectId);
      return;
    }

    const gasUsed = effects.gasUsed;

    // Calculate remaining balance after gas.
    // storageRebate can exceed costs (when objects are deleted),
    // making totalGas negative — that's correct (balance increases).
    const totalGas =
      BigInt(gasUsed.computationCost) +
      BigInt(gasUsed.storageCost) -
      BigInt(gasUsed.storageRebate) +
      BigInt(gasUsed.nonRefundableStorageFee ?? "0");
    // Clamp remaining to 0n minimum — if the on-chain balance somehow
    // differs from our tracking, we'd rather remove the coin than
    // operate with a nonsensical negative balance.
    const remaining =
      coin.balance - totalGas < 0n ? 0n : coin.balance - totalGas;

    if (remaining >= this.minCoinBalance) {
      // Coin still usable — update ref and balance
      coin.version = gasRef.version;
      coin.digest = gasRef.digest;
      coin.balance = remaining;
      coin.status = "available";
      coin.reservedAt = null;
    } else {
      // Coin exhausted — remove from pool
      this.coins.delete(objectId);
    }
  }

  /**
   * Remove coins whose reservations have expired.
   *
   * Expired coins are DELETED from the pool rather than recycled to "available".
   * This is a deliberate safety choice: if a client reserved a coin and never
   * called reportExecution(), we can't know whether the transaction was actually
   * submitted. If it was, the coin's ObjectRef on-chain has changed — reusing
   * the stale ref would cause a version mismatch or object equivocation.
   *
   * The pool shrinks naturally; operators should monitor getStats() and call
   * initialize() to replenish when needed.
   */
  recycleExpired(now: number): string[] {
    const expired: string[] = [];
    for (const [id, coin] of this.coins) {
      if (
        coin.status === "reserved" &&
        coin.reservedAt !== null &&
        now - coin.reservedAt > this.reservationTimeoutMs
      ) {
        this.coins.delete(id);
        expired.push(id);
      }
    }
    return expired;
  }

  /**
   * Re-fetch all coin ObjectRefs from the network.
   * Called after epoch change when coin versions may have shifted.
   */
  async revalidatePool(client: SuiClient): Promise<void> {
    const poolIds = [...this.coins.keys()];
    if (poolIds.length === 0) return;

    const objects = await client.multiGetObjects({
      ids: poolIds,
      options: { showContent: true },
    });

    for (let i = 0; i < poolIds.length; i++) {
      const id = poolIds[i];
      const obj = objects[i];
      const coin = this.coins.get(id);
      if (!coin) continue;

      // Skip reserved coins — their versions will be updated via
      // reportExecution() when the in-flight transaction completes.
      // Overwriting a reserved coin's ref mid-flight would cause
      // a version mismatch when the caller reports execution.
      if (coin.status === "reserved") continue;

      if (obj.data) {
        // Coin still exists — update ref
        coin.version = obj.data.version;
        coin.digest = obj.data.digest;
        // Update balance from content if available
        const content = obj.data.content;
        if (content && "fields" in content) {
          const fields = content.fields as Record<string, unknown>;
          if (typeof fields.balance === "string") {
            coin.balance = BigInt(fields.balance);
          }
        }
      } else {
        // Coin no longer exists (maybe merged by system)
        this.coins.delete(id);
      }
    }
  }

  /**
   * Merge remaining pool coins back into source on close.
   * Only merges available coins — reserved coins are abandoned
   * (their transactions are presumably still in-flight).
   */
  async close(client: SuiClient, signer: Signer): Promise<void> {
    // Recycle any expired reservations first (removes stale coins)
    this.recycleExpired(Date.now());

    const available = [...this.coins.values()].filter(
      (c) => c.status === "available",
    );
    if (available.length <= 1) {
      this.coins.clear();
      return;
    }

    const tx = new Transaction();
    const address = signer.toSuiAddress();
    tx.setSender(address);

    // Merge all pool coins into the first one
    const [primary, ...rest] = available;
    const restObjectRefs = rest.map((c) => ({
      objectId: c.objectId,
      version: c.version,
      digest: c.digest,
    }));

    if (restObjectRefs.length > 0) {
      tx.mergeCoins(
        tx.object(primary.objectId),
        restObjectRefs.map((ref) => tx.object(ref.objectId)),
      );
    }

    // Use primary coin as gas payment for the merge transaction
    tx.setGasPayment([
      {
        objectId: primary.objectId,
        version: primary.version,
        digest: primary.digest,
      },
    ]);

    const bytes = await tx.build({ client });
    const { signature } = await signer.signTransaction(bytes);
    await client.executeTransactionBlock({
      transactionBlock: bytes,
      signature,
    });

    this.coins.clear();
  }

  getStats(): {
    total: number;
    available: number;
    reserved: number;
    totalBalance: bigint;
  } {
    let available = 0;
    let reserved = 0;
    let totalBalance = 0n;

    for (const coin of this.coins.values()) {
      if (coin.status === "available") available++;
      else reserved++;
      totalBalance += coin.balance;
    }

    return { total: this.coins.size, available, reserved, totalBalance };
  }

  get size(): number {
    return this.coins.size;
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  /**
   * Fetch all SUI coins owned by an address, handling pagination.
   */
  private async fetchAllCoins(
    client: SuiClient,
    address: string,
  ): Promise<
    Array<{
      coinObjectId: string;
      version: string;
      digest: string;
      balance: string;
    }>
  > {
    const allCoins: Array<{
      coinObjectId: string;
      version: string;
      digest: string;
      balance: string;
    }> = [];
    let cursor: string | null | undefined = undefined;
    let hasNext = true;

    while (hasNext) {
      const page = await client.getCoins({
        owner: address,
        coinType: "0x2::sui::SUI",
        cursor: cursor ?? undefined,
      });
      allCoins.push(...page.data);
      cursor = page.nextCursor;
      hasNext = page.hasNextPage;
    }

    return allCoins;
  }

  /**
   * Split source coins into pool-sized pieces.
   * Ported from ParallelTransactionExecutor.refillCoinPool.
   */
  private async splitCoins(
    client: SuiClient,
    signer: Signer,
    sourceRefs: Array<{ objectId: string; version: string; digest: string }>,
    count: number,
  ): Promise<void> {
    const tx = new Transaction();
    const address = signer.toSuiAddress();
    tx.setSender(address);

    // Use source coins as gas payment for the split transaction
    tx.setGasPayment(sourceRefs);

    // Split gas coin into `count` pieces
    const amounts = Array.from({ length: count }, () => this.targetCoinBalance);
    const results = tx.splitCoins(tx.gas, amounts);

    // Transfer split coins back to sponsor address
    const coinResults = [];
    for (let i = 0; i < count; i++) {
      coinResults.push(results[i]);
    }
    tx.transferObjects(coinResults, address);

    const bytes = await tx.build({ client });
    const { signature } = await signer.signTransaction(bytes);
    const response = await client.executeTransactionBlock({
      transactionBlock: bytes,
      signature,
      options: { showEffects: true, showObjectChanges: true },
    });

    // Extract created coin refs from the response
    const created = response.effects?.created;
    if (!created || created.length === 0) {
      throw new Error(
        "Split transaction succeeded but no created coins found in effects. " +
          "The sponsor address may have insufficient balance.",
      );
    }
    for (const entry of created) {
      const ref = entry.reference;
      this.coins.set(ref.objectId, {
        objectId: ref.objectId,
        version: ref.version,
        digest: ref.digest,
        balance: this.targetCoinBalance,
        status: "available",
        reservedAt: null,
      });
    }
  }
}
