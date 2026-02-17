/**
 * Test helpers: mock SuiClient, mock Signer, mock TransactionEffects
 */
import { vi } from "vitest";
import type { ExecutionEffects } from "../src/types.js";

// Valid Sui addresses/object IDs (must be 32 bytes = 64 hex chars + 0x prefix)
export const SPONSOR_ADDR = "0x" + "aa".repeat(32);

// Valid base58-encoded 32-byte digests (Sui validates ObjectDigest format)
const VALID_DIGESTS = [
  "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
  "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
  "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8",
  "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq",
  "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY",
];

/** Generate a valid Sui object ID from a short hex label */
export function objectId(label: string): string {
  return "0x" + label.padStart(64, "0");
}

// ─── Mock Coin Data ─────────────────────────────────────────────────

export function makeCoin(
  id: string, // short hex label like "c1", "c2" etc (hex chars only!)
  balance: string,
  version = "1",
  digest = VALID_DIGESTS[0],
) {
  const oid = objectId(id);
  return {
    coinObjectId: oid,
    coinType: "0x2::sui::SUI",
    version,
    digest,
    balance,
    previousTransaction: "tx_" + id,
  };
}

// ─── Mock SuiClient ─────────────────────────────────────────────────

export function mockSuiClient(options: {
  coins?: ReturnType<typeof makeCoin>[];
  referenceGasPrice?: string;
  epoch?: string;
  epochStartTimestampMs?: string;
  epochDurationMs?: string;
}) {
  const coins = options.coins ?? [
    makeCoin("a1", "1000000000"),
    makeCoin("a2", "1000000000"),
    makeCoin("a3", "1000000000"),
  ];

  // v2 core resolver methods (used by Transaction.build({ client }))
  const core = {
    // Return null to use the default coreClientResolveTransactionPlugin
    resolveTransactionPlugin: vi.fn().mockReturnValue(null),
    getCurrentSystemState: vi.fn().mockResolvedValue({
      systemState: {
        epoch: options.epoch ?? "100",
        referenceGasPrice: options.referenceGasPrice ?? "1000",
      },
    }),
    getObjects: vi
      .fn()
      .mockImplementation(({ objectIds }: { objectIds: string[] }) => ({
        objects: objectIds.map((id: string) => {
          const coin = coins.find((c) => c.coinObjectId === id);
          if (coin) {
            return {
              objectId: coin.coinObjectId,
              version: coin.version,
              digest: coin.digest,
              owner: { $kind: "AddressOwner", AddressOwner: SPONSOR_ADDR },
            };
          }
          // Return a minimal object for unknown IDs
          return {
            objectId: id,
            version: "1",
            digest: VALID_DIGESTS[0],
            owner: { $kind: "AddressOwner", AddressOwner: SPONSOR_ADDR },
          };
        }),
      })),
    simulateTransaction: vi.fn().mockResolvedValue({
      $kind: "Transaction",
      Transaction: {
        effects: {
          gasUsed: {
            computationCost: "1000",
            storageCost: "2000",
            storageRebate: "500",
          },
        },
      },
    }),
    getChainIdentifier: vi.fn().mockResolvedValue({
      chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfJPsmHJ29eMFg",
    }),
  };

  const client = {
    core,
    getCoins: vi.fn().mockResolvedValue({
      data: coins,
      nextCursor: null,
      hasNextPage: false,
    }),
    multiGetObjects: vi.fn().mockResolvedValue(
      coins.map((c) => ({
        data: {
          objectId: c.coinObjectId,
          version: c.version,
          digest: c.digest,
          content: {
            dataType: "moveObject",
            type: "0x2::coin::Coin<0x2::sui::SUI>",
            fields: { balance: c.balance },
          },
        },
      })),
    ),
    getLatestSuiSystemState: vi.fn().mockResolvedValue({
      epoch: options.epoch ?? "100",
      referenceGasPrice: options.referenceGasPrice ?? "1000",
      epochStartTimestampMs:
        options.epochStartTimestampMs ?? String(Date.now() - 3600_000),
      epochDurationMs: options.epochDurationMs ?? "86400000", // 24h
    }),
    executeTransactionBlock: vi.fn().mockResolvedValue({
      digest: "mock_digest",
      effects: {
        status: { status: "success" },
        created: coins.slice(0, 3).map((_c, i) => ({
          reference: {
            objectId: objectId(`e${i}`),
            version: "2",
            digest: VALID_DIGESTS[i] ?? VALID_DIGESTS[0],
          },
          owner: { AddressOwner: SPONSOR_ADDR },
        })),
        gasObject: {
          reference: {
            objectId: coins[0]?.coinObjectId ?? objectId("gas"),
            version: "2",
            digest: VALID_DIGESTS[4],
          },
          owner: { AddressOwner: SPONSOR_ADDR },
        },
        gasUsed: {
          computationCost: "1000",
          storageCost: "2000",
          storageRebate: "500",
          nonRefundableStorageFee: "0",
        },
      },
    }),
    // v1 compat (still used by GasSponsor directly)
    getReferenceGasPrice: vi
      .fn()
      .mockResolvedValue(BigInt(options.referenceGasPrice ?? "1000")),
    dryRunTransactionBlock: vi.fn().mockResolvedValue({
      effects: {
        status: { status: "success" },
        gasUsed: {
          computationCost: "1000",
          storageCost: "2000",
          storageRebate: "500",
          nonRefundableStorageFee: "0",
        },
      },
    }),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

  return client;
}

// ─── Mock Signer ────────────────────────────────────────────────────

export function mockSigner(address = SPONSOR_ADDR) {
  return {
    toSuiAddress: vi.fn().mockReturnValue(address),
    signTransaction: vi.fn().mockResolvedValue({
      bytes: "bW9ja19ieXRlcw==", // "mock_bytes" in base64
      signature: "bW9ja19zaWduYXR1cmU=", // "mock_signature" in base64
    }),
    signWithIntent: vi.fn(),
    getKeyScheme: vi.fn().mockReturnValue("ED25519"),
    getPublicKey: vi.fn(),
    signPersonalMessage: vi.fn(),
    signAndExecuteTransaction: vi.fn(),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ─── Mock Execution Effects ─────────────────────────────────────────

export function mockEffects(
  gasObjectId: string,
  options?: {
    version?: string;
    digest?: string;
    computationCost?: string;
    storageCost?: string;
    storageRebate?: string;
    nonRefundableStorageFee?: string;
  },
): ExecutionEffects {
  return {
    gasObject: {
      reference: {
        objectId: gasObjectId,
        version: options?.version ?? "3",
        digest: options?.digest ?? VALID_DIGESTS[2],
      },
    },
    gasUsed: {
      computationCost: options?.computationCost ?? "5000000",
      storageCost: options?.storageCost ?? "2000000",
      storageRebate: options?.storageRebate ?? "1000000",
      nonRefundableStorageFee: options?.nonRefundableStorageFee ?? "0",
    },
  };
}
