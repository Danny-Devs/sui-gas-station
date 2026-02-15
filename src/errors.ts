// Copyright (c) Danny Devs
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error codes for actionable error handling.
 * Callers can switch on `error.code` to determine recovery strategy.
 */
export type GasStationErrorCode =
  | "POOL_EXHAUSTED" // No coins available — wait or add funds
  | "POOL_NOT_INITIALIZED" // initialize() not called yet
  | "POLICY_VIOLATION" // Sponsorship policy check failed
  | "BUILD_FAILED" // Transaction build/dry-run failed
  | "SIGN_FAILED" // Keypair signing failed
  | "INVALID_EFFECTS"; // Bad effects data passed to reportExecution()

export class GasStationError extends Error {
  override readonly name = "GasStationError";

  constructor(
    public readonly code: GasStationErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
