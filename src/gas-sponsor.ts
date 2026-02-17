// Copyright (c) Danny Devs
// SPDX-License-Identifier: Apache-2.0

/**
 * GasSponsor — the single public entry point for gas sponsorship.
 *
 * Usage:
 *   const sponsor = new GasSponsor({ client, signer });
 *   await sponsor.initialize();
 *   const result = await sponsor.sponsorTransaction({ sender, transactionKindBytes });
 *   // ... user signs and executes ...
 *   sponsor.reportExecution(result.reservation, response.effects);
 */
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Signer } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { CoinPool } from "./coin-pool.js";
import { GasStationError } from "./errors.js";
import { assertNoGasCoinUsage, validatePolicy } from "./policy.js";
import type {
  ExecutionEffects,
  GasCoinReservation,
  GasPriceCache,
  GasSponsorOptions,
  PoolStats,
  SponsoredTransaction,
  SponsorPolicy,
} from "./types.js";

// ─── Defaults (matching ParallelTransactionExecutor) ────────────────

const DEFAULT_EPOCH_BOUNDARY_WINDOW = 1_000; // 1 second (matches PTE)
const DEFAULT_TARGET_COIN_BALANCE = 500_000_000n; // 0.5 SUI

// ─── GasSponsor ─────────────────────────────────────────────────────

const MAX_EPOCH_BOUNDARY_WAIT = 30_000; // 30 second cap prevents clock-skew hangs
const SUI_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;

export class GasSponsor {
  private readonly client: SuiJsonRpcClient;
  private readonly signer: Signer;
  private readonly defaultPolicy?: SponsorPolicy;
  private readonly pool: CoinPool;
  private readonly epochBoundaryWindow: number;
  private readonly defaultMaxBudget: bigint;
  private readonly onPoolDepleted?: (stats: PoolStats) => void;

  private gasPriceCache: GasPriceCache | null = null;
  private needsRevalidation = false;
  private initialized = false;

  constructor(options: GasSponsorOptions) {
    this.client = options.client;
    this.signer = options.signer;
    this.defaultPolicy = options.policy;
    this.epochBoundaryWindow =
      options.epochBoundaryWindow ?? DEFAULT_EPOCH_BOUNDARY_WINDOW;

    this.defaultMaxBudget =
      options.targetCoinBalance ?? DEFAULT_TARGET_COIN_BALANCE;
    this.onPoolDepleted = options.onPoolDepleted;

    this.pool = new CoinPool({
      targetPoolSize: options.targetPoolSize,
      targetCoinBalance: options.targetCoinBalance,
      minCoinBalance: options.minCoinBalance,
      reservationTimeoutMs: options.reservationTimeoutMs,
    });
  }

  /**
   * Initialize the gas station: split coins into pool, cache gas price.
   * Must be called before sponsorTransaction().
   */
  async initialize(): Promise<void> {
    await this.pool.initialize(this.client, this.signer);
    await this.refreshGasPrice();
    this.initialized = true;
  }

  /**
   * Replenish the coin pool by fetching and splitting new coins.
   * Call this when the pool is depleted (e.g., from the onPoolDepleted callback).
   *
   * Safe to call while transactions are in-flight — reserved coins are preserved.
   * Only adds NEW coins from the network; does not disturb existing pool entries.
   */
  async replenish(): Promise<void> {
    if (!this.initialized) {
      throw new GasStationError(
        "POOL_NOT_INITIALIZED",
        "Call initialize() before replenish()",
      );
    }
    await this.pool.replenish(this.client, this.signer);
  }

  /**
   * Gracefully shut down: merge remaining pool coins.
   */
  async close(): Promise<void> {
    await this.pool.close(this.client, this.signer);
    this.initialized = false;
  }

  /**
   * Sponsor a transaction.
   *
   * @param options.sender - The sender's address (who signs as sender)
   * @param options.transactionKindBytes - Transaction kind bytes (base64 or Uint8Array)
   * @param options.gasBudget - Optional explicit gas budget (auto-estimated if omitted)
   * @param options.policy - Optional per-request policy override
   * @returns SponsoredTransaction with bytes, signature, and reservation handle
   */
  async sponsorTransaction(options: {
    sender: string;
    transactionKindBytes: string | Uint8Array;
    gasBudget?: bigint;
    policy?: SponsorPolicy;
  }): Promise<SponsoredTransaction> {
    if (!this.initialized) {
      throw new GasStationError(
        "POOL_NOT_INITIALIZED",
        "Call initialize() before sponsoring transactions",
      );
    }

    const { sender, transactionKindBytes, gasBudget } = options;
    const policy = options.policy ?? this.defaultPolicy;
    const sponsorAddress = this.signer.toSuiAddress();

    // 0. Validate sender address format
    if (!SUI_ADDRESS_RE.test(sender)) {
      throw new GasStationError(
        "POLICY_VIOLATION",
        `Invalid sender address format: ${sender}`,
        { sender },
      );
    }

    // 1. Check epoch freshness — reject during boundary window
    const gasPrice = await this.getGasPrice();

    // 2. Validate policy if provided
    if (policy) {
      const kindBytes =
        typeof transactionKindBytes === "string"
          ? fromBase64(transactionKindBytes)
          : transactionKindBytes;
      await validatePolicy(policy, sender, kindBytes, gasBudget ?? 0n);
    }

    // 3. Reserve a gas coin from the pool
    const coin = this.pool.reserve(gasBudget);
    if (!coin) {
      // Fire depletion callback (non-blocking) before throwing
      if (this.onPoolDepleted) {
        try {
          this.onPoolDepleted(this.getStats());
        } catch {
          // Callback errors must not mask the POOL_EXHAUSTED error
        }
      }
      throw new GasStationError(
        "POOL_EXHAUSTED",
        "No gas coins available. Wait for in-flight transactions to complete.",
        { poolStats: this.pool.getStats() },
      );
    }

    // Proactive low-pool warning: fire onPoolDepleted when the last coin
    // is taken, giving operators a chance to replenish before the next
    // request fails. This addresses silent pool depletion from expired
    // reservations (coins deleted by recycleExpired but never reported).
    if (this.onPoolDepleted && this.pool.getStats().available === 0) {
      try {
        this.onPoolDepleted(this.getStats());
      } catch {
        // Callback errors must not affect sponsorship flow
      }
    }

    try {
      // 4. Reconstruct transaction from kind bytes
      let tx: Transaction;
      try {
        tx = Transaction.fromKind(transactionKindBytes);
      } catch (err) {
        throw new GasStationError(
          "BUILD_FAILED",
          `Invalid transaction kind bytes: ${err instanceof Error ? err.message : String(err)}`,
          { sender },
        );
      }

      // 4b. Reject gas coin manipulation (drain prevention).
      // A malicious sender can craft kind bytes with SplitCoins(GasCoin, [amount])
      // to extract value from the sponsor's gas coin. This check runs
      // unconditionally unless the operator explicitly opts in via policy.
      if (!policy?.allowGasCoinUsage) {
        assertNoGasCoinUsage(tx.getData().commands, sender);
      }

      // 5. Attach gas data
      tx.setSender(sender);
      tx.setGasOwner(sponsorAddress);
      tx.setGasPayment([
        {
          objectId: coin.objectId,
          version: coin.version,
          digest: coin.digest,
        },
      ]);
      tx.setGasPrice(gasPrice);

      // 6. Set gas budget (defense-in-depth: always cap, matching PTE pattern)
      if (gasBudget !== undefined) {
        tx.setGasBudget(gasBudget);
      } else if (policy?.maxBudgetPerTx !== undefined) {
        // Use policy max as ceiling for auto-estimation. This prevents
        // the dry-run from estimating an arbitrarily high budget, and
        // avoids wasting RPC resources + signing before catching the violation.
        tx.setGasBudget(policy.maxBudgetPerTx);
      } else {
        // No explicit budget and no policy cap — fall back to targetCoinBalance.
        // Mirrors ParallelTransactionExecutor's setGasBudgetIfNotSet(minimumCoinBalance)
        // pattern: always cap the dry-run to bound max gas spend per transaction.
        tx.setGasBudget(this.defaultMaxBudget);
      }

      // 7. Build full transaction bytes
      let txBytes: Uint8Array;
      try {
        txBytes = await tx.build({ client: this.client });
      } catch (err) {
        throw new GasStationError(
          "BUILD_FAILED",
          `Transaction build failed: ${err instanceof Error ? err.message : String(err)}`,
          { sender, sponsorAddress },
        );
      }

      // 8. Sign as sponsor
      let sponsorSignature: string;
      try {
        const signed = await this.signer.signTransaction(txBytes);
        sponsorSignature = signed.signature;
      } catch (err) {
        throw new GasStationError(
          "SIGN_FAILED",
          `Sponsor signing failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 9. Extract the actual gas budget from built transaction
      // (may differ from requested if auto-estimated)
      const builtTx = Transaction.from(txBytes);
      const builtBudget = BigInt(builtTx.getData().gasData.budget ?? 0);

      // 10. Post-build budget check — catches auto-estimated budgets
      // that exceed policy.maxBudgetPerTx (pre-build check only saw
      // the explicit gasBudget, which may have been omitted/0n).
      if (
        policy?.maxBudgetPerTx !== undefined &&
        builtBudget > policy.maxBudgetPerTx
      ) {
        throw new GasStationError(
          "POLICY_VIOLATION",
          `Auto-estimated gas budget ${builtBudget} exceeds policy max ${policy.maxBudgetPerTx}`,
          { sender, builtBudget, maxBudgetPerTx: policy.maxBudgetPerTx },
        );
      }

      return {
        transactionBytes: toBase64(txBytes),
        sponsorSignature,
        gasBudget: builtBudget,
        gasPrice,
        reservation: {
          objectId: coin.objectId,
          reservedAt: coin.reservedAt ?? Date.now(),
        },
      };
    } catch (err) {
      // On any error, release the reserved coin back to the pool
      this.pool.release(coin.objectId);
      throw err;
    }
  }

  /**
   * Report transaction execution results.
   * Updates the pool coin with its new ObjectRef from the effects.
   *
   * MUST be called after every sponsored transaction executes.
   * Pass `response.effects` from executeTransactionBlock({ options: { showEffects: true } }).
   */
  reportExecution(
    reservation: GasCoinReservation,
    effects: ExecutionEffects,
  ): void {
    if (!effects?.gasObject?.reference || !effects?.gasUsed) {
      throw new GasStationError(
        "INVALID_EFFECTS",
        "Invalid execution effects: missing gasObject.reference or gasUsed. " +
          "Ensure executeTransactionBlock was called with { options: { showEffects: true } }.",
      );
    }
    this.pool.updateFromEffects(effects, reservation.objectId);
  }

  /**
   * Get current pool and gas price statistics for monitoring.
   */
  getStats(): PoolStats {
    const poolStats = this.pool.getStats();
    return {
      totalCoins: poolStats.total,
      availableCoins: poolStats.available,
      reservedCoins: poolStats.reserved,
      totalBalance: poolStats.totalBalance,
      sponsorAddress: this.signer.toSuiAddress(),
      currentEpoch: this.gasPriceCache?.epoch ?? "unknown",
      gasPrice: this.gasPriceCache?.price ?? 0n,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  /**
   * Get the current gas price, refreshing cache if needed.
   * Detects epoch changes and handles boundary window.
   *
   * Ported from ParallelTransactionExecutor.getGasPrice pattern.
   */
  private async getGasPrice(): Promise<bigint> {
    // If a previous revalidation failed, retry it now
    if (this.needsRevalidation) {
      try {
        await this.pool.revalidatePool(this.client);
        this.needsRevalidation = false;
      } catch {
        // Still can't revalidate — continue with potentially stale pool
      }
    }

    if (this.gasPriceCache) {
      const remaining =
        this.gasPriceCache.expiration - this.epochBoundaryWindow - Date.now();

      if (remaining > 0) {
        return this.gasPriceCache.price;
      }

      // We're within the epoch boundary window — wait it out
      const timeToNextEpoch = Math.min(
        Math.max(
          this.gasPriceCache.expiration + this.epochBoundaryWindow - Date.now(),
          1_000, // minimum 1 second wait
        ),
        MAX_EPOCH_BOUNDARY_WAIT, // cap prevents clock-skew hangs
      );

      await new Promise((resolve) => setTimeout(resolve, timeToNextEpoch));
    }

    // Refresh gas price and epoch info
    await this.refreshGasPrice();
    return this.gasPriceCache!.price;
  }

  /**
   * Fetch fresh reference gas price and epoch info from the network.
   * Detects epoch changes and revalidates pool if needed.
   */
  private async refreshGasPrice(): Promise<void> {
    const state = await this.client.getLatestSuiSystemState();
    const previousEpoch = this.gasPriceCache?.epoch;
    const currentEpoch = state.epoch;

    this.gasPriceCache = {
      price: BigInt(state.referenceGasPrice),
      epoch: currentEpoch,
      expiration:
        Number.parseInt(state.epochStartTimestampMs, 10) +
        Number.parseInt(state.epochDurationMs, 10),
      fetchedAt: Date.now(),
    };

    // If epoch changed, revalidate pool (coin versions may have shifted)
    if (previousEpoch && previousEpoch !== currentEpoch) {
      try {
        await this.pool.revalidatePool(this.client);
      } catch {
        // Revalidation failed — flag for retry on next getGasPrice() call.
        // Continue operating with potentially stale pool rather than crashing.
        this.needsRevalidation = true;
      }
    }
  }
}
