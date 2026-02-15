// Copyright (c) Danny Devs
// SPDX-License-Identifier: Apache-2.0

import type { SuiClient } from "@mysten/sui/client";
import type { Signer } from "@mysten/sui/cryptography";

// ─── Constructor Options ────────────────────────────────────────────

export interface GasSponsorOptions {
  /** Sui JSON-RPC client */
  client: SuiClient;
  /** Sponsor keypair — owns the gas coins, signs sponsored transactions */
  signer: Signer;
  /** Default policy applied to all requests (can be overridden per-request) */
  policy?: SponsorPolicy;
  /** Number of coins to maintain in the pool. Default: 20 */
  targetPoolSize?: number;
  /** Balance to allocate per pool coin (in MIST). Default: 500_000_000 (0.5 SUI) */
  targetCoinBalance?: bigint;
  /** Minimum coin balance for reuse after execution. Default: 50_000_000 (0.05 SUI) */
  minCoinBalance?: bigint;
  /** Auto-release reserved coins after this many ms. Default: 30_000 (30s) */
  reservationTimeoutMs?: number;
  /**
   * Time to wait before/after epoch boundary before resuming sponsorship (ms).
   * Matches ParallelTransactionExecutor's epochBoundaryWindow pattern.
   * Default: 1_000 (1s)
   */
  epochBoundaryWindow?: number;
  /**
   * Called when the pool has no available coins (all reserved or deleted).
   * Use this to trigger replenishment, alerting, or circuit-breaking.
   *
   * Example: `onPoolDepleted: (stats) => sponsor.replenish()`
   */
  onPoolDepleted?: (stats: PoolStats) => void;
}

// ─── Sponsorship Result ─────────────────────────────────────────────

export interface SponsoredTransaction {
  /** Base64-encoded transaction bytes — sender must sign these */
  transactionBytes: string;
  /** Base64-encoded sponsor signature */
  sponsorSignature: string;
  /** Gas budget applied to this transaction (in MIST) */
  gasBudget: bigint;
  /** Reference gas price used (in MIST) */
  gasPrice: bigint;
  /** Reservation handle — pass to reportExecution() after tx completes */
  reservation: GasCoinReservation;
}

export interface GasCoinReservation {
  /** Object ID of the reserved gas coin */
  objectId: string;
  /** Timestamp when the coin was reserved */
  reservedAt: number;
}

// ─── Pool Stats ─────────────────────────────────────────────────────

export interface PoolStats {
  totalCoins: number;
  availableCoins: number;
  reservedCoins: number;
  totalBalance: bigint;
  sponsorAddress: string;
  currentEpoch: string;
  gasPrice: bigint;
}

// ─── Policy ─────────────────────────────────────────────────────────

export interface SponsorPolicy {
  /** Maximum gas budget per transaction (in MIST) */
  maxBudgetPerTx?: bigint;
  /** Allowlist of Move function targets (e.g. '0xpkg::module::function') */
  allowedMoveTargets?: string[];
  /** Blocklist of sender addresses */
  blockedAddresses?: string[];
  /**
   * Allow transaction kind bytes to reference the gas coin in PTB commands
   * (SplitCoins, TransferObjects, MergeCoins, MoveCall, MakeMoveVec).
   *
   * Default: false — rejects gas coin manipulation to prevent drain attacks
   * where malicious kind bytes extract value from the sponsor's gas coin.
   *
   * Set to true only if your gas station intentionally funds user operations
   * beyond gas payment (e.g. splitting SUI from the gas coin for in-tx use).
   */
  allowGasCoinUsage?: boolean;
  /** Custom validation function — return false to reject */
  customValidator?: (
    sender: string,
    kindBytes: Uint8Array,
  ) => boolean | Promise<boolean>;
}

// ─── Execution Effects (structural type — compatible with SDK's TransactionEffects) ─

/**
 * Minimal effects data needed by reportExecution().
 * Structurally compatible with the SDK's `TransactionEffects` from
 * `executeTransactionBlock({ options: { showEffects: true } })`.
 *
 * Users just pass `response.effects` — no conversion needed.
 */
export interface ExecutionEffects {
  /** The gas coin's post-execution state */
  gasObject: {
    reference: { objectId: string; version: string; digest: string };
  };
  /** Gas costs from execution */
  gasUsed: {
    computationCost: string;
    storageCost: string;
    storageRebate: string;
    /** Fee retained by the storage fund (not rebated). Optional for backwards compat. */
    nonRefundableStorageFee?: string;
  };
}

// ─── Internal Types (used by CoinPool, not exported from index) ─────

export interface CoinEntry {
  objectId: string;
  version: string;
  digest: string;
  balance: bigint;
  status: "available" | "reserved";
  reservedAt: number | null;
}

export interface GasPriceCache {
  price: bigint;
  epoch: string;
  /** Epoch end timestamp (ms since Unix epoch) */
  expiration: number;
  /** When this cache entry was fetched */
  fetchedAt: number;
}
