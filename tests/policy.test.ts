import { describe, it, expect } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { validatePolicy, extractMoveTargets } from "../src/policy.js";
import { GasStationError } from "../src/errors.js";

/** Build kind bytes containing a single MoveCall */
async function buildMoveCallKind(target: string): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.moveCall({ target });
  return tx.build({ onlyTransactionKind: true });
}

/** Build kind bytes containing multiple MoveCall commands */
async function buildMultiMoveCallKind(targets: string[]): Promise<Uint8Array> {
  const tx = new Transaction();
  for (const target of targets) {
    tx.moveCall({ target });
  }
  return tx.build({ onlyTransactionKind: true });
}

/** Build kind bytes with no MoveCall (just a transfer) */
async function buildTransferKind(): Promise<Uint8Array> {
  const tx = new Transaction();
  const recipient = "0x" + "cd".repeat(32);
  tx.transferObjects([tx.splitCoins(tx.gas, [1000n])], recipient);
  return tx.build({ onlyTransactionKind: true });
}

describe("validatePolicy", () => {
  const sender = "0xsender123";
  const kindBytes = new Uint8Array([1, 2, 3]);

  it("passes when no constraints are set", async () => {
    await expect(
      validatePolicy({}, sender, kindBytes, 1000n),
    ).resolves.not.toThrow();
  });

  describe("maxBudgetPerTx", () => {
    it("passes when budget is under limit", async () => {
      await expect(
        validatePolicy({ maxBudgetPerTx: 2000n }, sender, kindBytes, 1000n),
      ).resolves.not.toThrow();
    });

    it("passes when budget equals limit", async () => {
      await expect(
        validatePolicy({ maxBudgetPerTx: 1000n }, sender, kindBytes, 1000n),
      ).resolves.not.toThrow();
    });

    it("throws POLICY_VIOLATION when budget exceeds limit", async () => {
      await expect(
        validatePolicy({ maxBudgetPerTx: 500n }, sender, kindBytes, 1000n),
      ).rejects.toThrow(GasStationError);

      try {
        await validatePolicy(
          { maxBudgetPerTx: 500n },
          sender,
          kindBytes,
          1000n,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(GasStationError);
        expect((err as GasStationError).code).toBe("POLICY_VIOLATION");
      }
    });
  });

  describe("blockedAddresses", () => {
    it("passes for non-blocked address", async () => {
      await expect(
        validatePolicy({ blockedAddresses: ["0xbad"] }, sender, kindBytes, 0n),
      ).resolves.not.toThrow();
    });

    it("throws POLICY_VIOLATION for blocked address", async () => {
      await expect(
        validatePolicy({ blockedAddresses: [sender] }, sender, kindBytes, 0n),
      ).rejects.toThrow(GasStationError);
    });

    it("matches short-form and full-form addresses", async () => {
      // Block using short-form, sender uses full-form (or vice versa)
      const shortForm = "0x2";
      const fullForm =
        "0x0000000000000000000000000000000000000000000000000000000000000002";

      await expect(
        validatePolicy(
          { blockedAddresses: [shortForm] },
          fullForm,
          kindBytes,
          0n,
        ),
      ).rejects.toThrow(GasStationError);

      await expect(
        validatePolicy(
          { blockedAddresses: [fullForm] },
          shortForm,
          kindBytes,
          0n,
        ),
      ).rejects.toThrow(GasStationError);
    });
  });

  describe("customValidator", () => {
    it("passes when validator returns true", async () => {
      await expect(
        validatePolicy({ customValidator: () => true }, sender, kindBytes, 0n),
      ).resolves.not.toThrow();
    });

    it("passes with async validator returning true", async () => {
      await expect(
        validatePolicy(
          { customValidator: async () => true },
          sender,
          kindBytes,
          0n,
        ),
      ).resolves.not.toThrow();
    });

    it("throws POLICY_VIOLATION when validator returns false", async () => {
      await expect(
        validatePolicy({ customValidator: () => false }, sender, kindBytes, 0n),
      ).rejects.toThrow(GasStationError);
    });
  });

  describe("allowedMoveTargets", () => {
    const ALLOWED_TARGET = "0x2::coin::transfer";
    const OTHER_TARGET = "0x3::nft::mint";

    it("passes when transaction contains only allowed targets", async () => {
      const kind = await buildMoveCallKind(ALLOWED_TARGET);
      await expect(
        validatePolicy(
          { allowedMoveTargets: [ALLOWED_TARGET] },
          sender,
          kind,
          0n,
        ),
      ).resolves.not.toThrow();
    });

    it("passes when multiple targets are all allowed", async () => {
      const kind = await buildMultiMoveCallKind([ALLOWED_TARGET, OTHER_TARGET]);
      await expect(
        validatePolicy(
          { allowedMoveTargets: [ALLOWED_TARGET, OTHER_TARGET] },
          sender,
          kind,
          0n,
        ),
      ).resolves.not.toThrow();
    });

    it("throws POLICY_VIOLATION for disallowed target", async () => {
      const kind = await buildMoveCallKind(OTHER_TARGET);
      await expect(
        validatePolicy(
          { allowedMoveTargets: [ALLOWED_TARGET] },
          sender,
          kind,
          0n,
        ),
      ).rejects.toThrow(GasStationError);

      try {
        await validatePolicy(
          { allowedMoveTargets: [ALLOWED_TARGET] },
          sender,
          kind,
          0n,
        );
      } catch (err) {
        expect((err as GasStationError).code).toBe("POLICY_VIOLATION");
        // Error message contains the full-form address from BCS deserialization
        expect((err as GasStationError).message).toContain("nft::mint");
        expect((err as GasStationError).details?.target).toContain("nft::mint");
      }
    });

    it("throws on first disallowed target in multi-call transaction", async () => {
      const kind = await buildMultiMoveCallKind([ALLOWED_TARGET, OTHER_TARGET]);
      await expect(
        validatePolicy(
          { allowedMoveTargets: [ALLOWED_TARGET] },
          sender,
          kind,
          0n,
        ),
      ).rejects.toThrow(GasStationError);
    });

    it("passes when transaction has no MoveCall commands", async () => {
      const kind = await buildTransferKind();
      await expect(
        validatePolicy(
          { allowedMoveTargets: [ALLOWED_TARGET] },
          sender,
          kind,
          0n,
        ),
      ).resolves.not.toThrow();
    });

    it("skips check when allowedMoveTargets is empty array", async () => {
      const kind = await buildMoveCallKind(OTHER_TARGET);
      await expect(
        validatePolicy({ allowedMoveTargets: [] }, sender, kind, 0n),
      ).resolves.not.toThrow();
    });

    it("rejects Publish commands when allowedMoveTargets is set", async () => {
      // Build kind bytes containing a Publish command
      const tx = new Transaction();
      tx.publish({ modules: [[0]], dependencies: [] });
      const kind = await tx.build({ onlyTransactionKind: true });

      await expect(
        validatePolicy(
          { allowedMoveTargets: [ALLOWED_TARGET] },
          sender,
          kind,
          0n,
        ),
      ).rejects.toThrow(GasStationError);

      try {
        await validatePolicy(
          { allowedMoveTargets: [ALLOWED_TARGET] },
          sender,
          kind,
          0n,
        );
      } catch (err) {
        expect((err as GasStationError).code).toBe("POLICY_VIOLATION");
        expect((err as GasStationError).message).toContain("Publish");
      }
    });

    // Note: Upgrade command test omitted because tx.upgrade() requires a
    // SuiClient for object resolution. The code path checks both "Publish"
    // and "Upgrade" in the same conditional (policy.ts), and the Publish
    // test above confirms the mechanism works.
  });

  describe("combined constraints", () => {
    it("checks budget first, then blocklist", async () => {
      // Budget violation should fire even though address is also blocked
      try {
        await validatePolicy(
          {
            maxBudgetPerTx: 100n,
            blockedAddresses: [sender],
          },
          sender,
          kindBytes,
          200n,
        );
      } catch (err) {
        expect((err as GasStationError).code).toBe("POLICY_VIOLATION");
        // Budget check comes first in the implementation
        expect((err as GasStationError).message).toContain("exceeds max");
      }
    });
  });
});

describe("extractMoveTargets", () => {
  // BCS deserialization returns full-form addresses (64 hex chars)
  const FULL_COIN = "0x" + "0".repeat(62) + "02" + "::coin::transfer";
  const FULL_NFT = "0x" + "0".repeat(62) + "03" + "::nft::mint";

  it("extracts single MoveCall target", async () => {
    const kind = await buildMoveCallKind("0x2::coin::transfer");
    const targets = extractMoveTargets(kind);
    expect(targets).toEqual([FULL_COIN]);
  });

  it("extracts multiple MoveCall targets", async () => {
    const kind = await buildMultiMoveCallKind([
      "0x2::coin::transfer",
      "0x3::nft::mint",
    ]);
    const targets = extractMoveTargets(kind);
    expect(targets).toEqual([FULL_COIN, FULL_NFT]);
  });

  it("returns empty array for non-MoveCall transaction", async () => {
    const kind = await buildTransferKind();
    const targets = extractMoveTargets(kind);
    expect(targets).toEqual([]);
  });
});
