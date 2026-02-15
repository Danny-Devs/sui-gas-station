// Copyright (c) Danny Devs
// SPDX-License-Identifier: Apache-2.0

// ─── Public API ─────────────────────────────────────────────────────
export { GasSponsor } from "./gas-sponsor.js";
export { GasStationError } from "./errors.js";
export type { GasStationErrorCode } from "./errors.js";
export { validatePolicy, extractMoveTargets } from "./policy.js";

// ─── Public Types ───────────────────────────────────────────────────
export type {
  GasSponsorOptions,
  SponsoredTransaction,
  GasCoinReservation,
  PoolStats,
  SponsorPolicy,
  ExecutionEffects,
} from "./types.js";

// NOTE: CoinPool and CoinEntry are intentionally NOT exported.
// The pool is an implementation detail of GasSponsor.
