// Copyright (c) Danny Devs
// SPDX-License-Identifier: Apache-2.0

import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { GasStationError } from "./errors.js";
import type { SponsorPolicy } from "./types.js";

/**
 * Validates a sponsorship request against a policy.
 * Pure function — no state, no rate limiting (that belongs in server middleware).
 * Throws GasStationError with code 'POLICY_VIOLATION' on failure.
 */
export async function validatePolicy(
  policy: SponsorPolicy,
  sender: string,
  kindBytes: Uint8Array,
  estimatedBudget: bigint,
): Promise<void> {
  // Budget cap
  if (
    policy.maxBudgetPerTx !== undefined &&
    estimatedBudget > policy.maxBudgetPerTx
  ) {
    throw new GasStationError(
      "POLICY_VIOLATION",
      `Budget ${estimatedBudget} exceeds max ${policy.maxBudgetPerTx}`,
      { sender, estimatedBudget, maxBudgetPerTx: policy.maxBudgetPerTx },
    );
  }

  // Blocklist — normalize addresses so 0x2 matches 0x000...002
  if (policy.blockedAddresses && policy.blockedAddresses.length > 0) {
    const normalizedSender = normalizeSuiAddress(sender);
    const blocked = policy.blockedAddresses.some(
      (addr) => normalizeSuiAddress(addr) === normalizedSender,
    );
    if (blocked) {
      throw new GasStationError(
        "POLICY_VIOLATION",
        `Sender ${sender} is blocked`,
        { sender },
      );
    }
  }

  // Allowed Move targets — deserialize kind bytes and inspect commands
  if (policy.allowedMoveTargets && policy.allowedMoveTargets.length > 0) {
    const tx = Transaction.fromKind(kindBytes);
    const commands = tx.getData().commands;

    // Reject Publish and Upgrade commands when allowedMoveTargets is set.
    // These are high-risk operations (deploy arbitrary code, consume significant gas)
    // that would bypass MoveCall-based restrictions.
    for (const command of commands) {
      if (command.$kind === "Publish" || command.$kind === "Upgrade") {
        throw new GasStationError(
          "POLICY_VIOLATION",
          `${command.$kind} commands are not allowed when allowedMoveTargets is set`,
          { sender, commandKind: command.$kind },
        );
      }
    }

    // Validate all MoveCall targets are in the allowlist
    const normalizedAllowed =
      policy.allowedMoveTargets.map(normalizeMoveTarget);
    const targets = extractMoveTargetsFromCommands(commands);
    for (const target of targets) {
      if (!normalizedAllowed.includes(target)) {
        throw new GasStationError(
          "POLICY_VIOLATION",
          `Move call target ${target} is not in allowedMoveTargets`,
          { sender, target, allowedMoveTargets: policy.allowedMoveTargets },
        );
      }
    }
  }

  // Custom validator (runs last — most expensive, user-defined)
  if (policy.customValidator) {
    const allowed = await policy.customValidator(sender, kindBytes);
    if (!allowed) {
      throw new GasStationError(
        "POLICY_VIOLATION",
        "Custom policy validator rejected the request",
        { sender },
      );
    }
  }
}

/**
 * Asserts that no PTB command references the GasCoin input.
 * Prevents drain attacks where a malicious sender crafts kind bytes containing
 * SplitCoins(GasCoin, [amount]) + TransferObjects to extract value from the
 * sponsor's gas coin beyond gas fees.
 *
 * Throws GasStationError with code 'POLICY_VIOLATION' if GasCoin is found.
 */
export function assertNoGasCoinUsage(
  commands: ReturnType<Transaction["getData"]>["commands"],
  sender: string,
): void {
  for (const command of commands) {
    const args = getCommandArguments(command);
    for (const arg of args) {
      if (arg.$kind === "GasCoin") {
        throw new GasStationError(
          "POLICY_VIOLATION",
          `${command.$kind} command references GasCoin. ` +
            "Gas coin manipulation is not allowed in sponsored transactions " +
            "to prevent value extraction from the sponsor's coin. " +
            "Set policy.allowGasCoinUsage = true to override.",
          { sender, commandKind: command.$kind },
        );
      }
    }
  }
}

/** Extract all arguments from a PTB command for GasCoin inspection. */
function getCommandArguments(
  command: ReturnType<Transaction["getData"]>["commands"][number],
): Array<{ $kind: string }> {
  switch (command.$kind) {
    case "SplitCoins":
      return [command.SplitCoins.coin, ...command.SplitCoins.amounts];
    case "TransferObjects":
      return [
        ...command.TransferObjects.objects,
        command.TransferObjects.address,
      ];
    case "MergeCoins":
      return [command.MergeCoins.destination, ...command.MergeCoins.sources];
    case "MoveCall":
      return command.MoveCall.arguments;
    case "MakeMoveVec":
      return command.MakeMoveVec.elements;
    case "Upgrade":
      return [command.Upgrade.ticket];
    case "Publish":
      return [];
    default:
      return [];
  }
}

/**
 * Extract Move call target strings from BCS-encoded transaction kind bytes.
 * Returns targets in normalized `package::module::function` format
 * (package address zero-padded to 64 hex chars).
 */
export function extractMoveTargets(kindBytes: Uint8Array): string[] {
  const tx = Transaction.fromKind(kindBytes);
  return extractMoveTargetsFromCommands(tx.getData().commands);
}

/** Internal: extract targets from already-parsed commands (avoids double deserialization). */
function extractMoveTargetsFromCommands(
  commands: ReturnType<Transaction["getData"]>["commands"],
): string[] {
  const targets: string[] = [];
  for (const command of commands) {
    if (command.$kind === "MoveCall") {
      const mc = command.MoveCall;
      targets.push(`${mc.package}::${mc.module}::${mc.function}`);
    }
  }
  return targets;
}

/**
 * Normalize a Move target string so that short-form addresses (0x2)
 * match the full-form (0x000...002) returned by BCS deserialization.
 */
function normalizeMoveTarget(target: string): string {
  const parts = target.split("::");
  if (parts.length !== 3) return target;
  const [pkg, mod, fn] = parts;
  return `${normalizeSuiAddress(pkg)}::${mod}::${fn}`;
}
