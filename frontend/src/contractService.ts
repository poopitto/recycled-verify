import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { CONTRACT_ADDRESS } from "./chain";

type Hex = `0x${string}`;
const TIMEOUT_MS = 240_000;

// ── Domain vocabulary ─────────────────────────────────────────────────────--
export type Ruling =
  | "VERIFIED"
  | "PARTIAL"
  | "GREENWASH"
  | "MASS_BALANCE_FAIL"
  | "DEPENDENCY_FLAGGED"
  | "";

// status: 0 REGISTERED, 1 TRACED, 2 BALANCE_OK, 3 AUDITED_T1,
//         4 AUDITED_T2, 5 LABELED, 6 REJECTED, 7 FLAGGED
export const STATUS_LABEL = [
  "REGISTERED",
  "TRACED",
  "BALANCE_OK",
  "AUDITED_T1",
  "AUDITED_T2",
  "LABELED",
  "REJECTED",
  "FLAGGED",
] as const;

export const ST_REGISTERED = 0;
export const ST_TRACED = 1;
export const ST_BALANCE_OK = 2;
export const ST_AUDITED_T1 = 3;
export const ST_AUDITED_T2 = 4;
export const ST_LABELED = 5;
export const ST_REJECTED = 6;
export const ST_FLAGGED = 7;

export const HIGH_VALUE_LOT_KG = 5000;
export const MASS_BALANCE_TOLERANCE_KG = 5;
export const MAX_PARENT_LOTS = 8;

// ── Domain types ──────────────────────────────────────────────────────────--
export interface LotView {
  lotId: number;
  claimant: string;
  publicLabel: string;
  material: string;
  region: string;
  lotMassKg: number;
  claimedRecycledMassKg: number;
  parentLotIds: number[];
  childLotIds: number[];
  trace: string;
  bondWei: string;
  status: number;
  ruling: Ruling;
  verifiedRecycledPct: number;
  recycledPctT1: number;
  recycledPctT2: number;
  massBalanceOk: boolean;
  labelIssued: boolean;
  rationale: string;
  sybilDensity: number;
  registeredEpoch: number;
  auditedEpoch: number;
  labeledEpoch: number;
  ancestorFlagSource: number;
}
export interface LotRow extends LotView {
  id: number;
}

export interface Counts {
  next: number;
  audited: number;
  verified: number;
  rejected: number;
  cascadeFlagged: number;
  totalLabels: number;
  epoch: number;
}

export interface MassBalanceResult {
  lotId: number;
  massBalanceOk: boolean;
  claimedRecycledKg: number;
  parentCapacityKg: number;
  parents: { parentId: number; contributedKg: number; parentStatus: number }[];
}

// ── Clients ─────────────────────────────────────────────────────────────---
function readClient() {
  return createClient({ chain: studionet, account: createAccount() });
}
function writeClient(account: Hex) {
  return createClient({ chain: studionet, account });
}

async function waitAccepted(client: any, hash: Hex) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Transaction timed out")), TIMEOUT_MS);
  });
  try {
    await Promise.race([
      client.waitForTransactionReceipt({
        hash: hash as never,
        status: TransactionStatus.ACCEPTED,
        interval: 5000,
        retries: 64,
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Defensive parsing ───────────────────────────────────────────────────---
function pick(obj: any, key: string, idx: number): any {
  if (obj == null) return undefined;
  if (Array.isArray(obj)) return obj[idx];
  if (typeof obj === "object" && key in obj) return obj[key];
  return undefined;
}
function numArr(v: any): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => Number(x) || 0);
}

// ── Bond estimation (mirrors the contract's density formula) ────────────────
// required = MIN_BOND_WEI * (DENSITY_DENOM + density * DENSITY_NUMER) / DENSITY_DENOM
export const MIN_BOND_WEI = 5_000_000_000_000_000n; // 0.005 GEN
const DENSITY_NUMER = 15n;
const DENSITY_DENOM = 10n;
export function requiredBondWei(density: number): bigint {
  const d = BigInt(Math.max(0, Math.floor(density)));
  return (MIN_BOND_WEI * (DENSITY_DENOM + d * DENSITY_NUMER)) / DENSITY_DENOM;
}
export function weiToGen(wei: bigint): string {
  // 18 decimals, render up to 6 fractional digits.
  const whole = wei / 1_000_000_000_000_000_000n;
  const frac = wei % 1_000_000_000_000_000_000n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

// ── Writes ──────────────────────────────────────────────────────────────---
export async function registerLot(
  account: Hex,
  f: {
    publicLabel: string;
    material: string;
    region: string;
    lotMassKg: number;
    claimedRecycledMassKg: number;
    parentLotIdsCsv: string;
    bondWei: bigint;
  }
): Promise<number> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "register_lot",
    args: [
      f.publicLabel.trim(),
      f.material.trim(),
      f.region.trim(),
      Math.floor(f.lotMassKg),
      Math.floor(f.claimedRecycledMassKg),
      f.parentLotIdsCsv.trim(),
    ],
    value: f.bondWei,
  })) as Hex;
  await waitAccepted(wc, h);
  const c = await getCounts();
  return c.next - 1;
}

export async function submitTrace(account: Hex, lotId: number, trace: string): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "submit_trace",
    args: [lotId, trace.trim()],
    value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

export async function verifyMassBalance(account: Hex, lotId: number): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "verify_mass_balance",
    args: [lotId],
    value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

export async function adjudicate(account: Hex, lotId: number): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "adjudicate",
    args: [lotId],
    value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

export async function adjudicateDeep(account: Hex, lotId: number): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "adjudicate_deep",
    args: [lotId],
    value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

export async function issueLabel(account: Hex, lotId: number): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "issue_label",
    args: [lotId],
    value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

export async function cascadeFlagDescendants(account: Hex, ancestorLotId: number): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "cascade_flag_descendants",
    args: [ancestorLotId],
    value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

export async function advanceEpoch(account: Hex): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "advance_epoch",
    args: [],
    value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

export async function setAdmin(account: Hex, newAdmin: string): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "set_admin",
    args: [newAdmin.trim()],
    value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

// ── Views ───────────────────────────────────────────────────────────────---
export async function getLot(lotId: number): Promise<LotView> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "get_lot",
    args: [lotId],
  });
  return {
    lotId: Number(pick(r, "lot_id", 0) ?? lotId),
    claimant: String(pick(r, "claimant", 1) ?? ""),
    publicLabel: String(pick(r, "public_label", 2) ?? ""),
    material: String(pick(r, "material", 3) ?? ""),
    region: String(pick(r, "region", 4) ?? ""),
    lotMassKg: Number(pick(r, "lot_mass_kg", 5) ?? 0),
    claimedRecycledMassKg: Number(pick(r, "claimed_recycled_mass_kg", 6) ?? 0),
    parentLotIds: numArr(pick(r, "parent_lot_ids", 7)),
    childLotIds: numArr(pick(r, "child_lot_ids", 8)),
    trace: String(pick(r, "trace", 9) ?? ""),
    bondWei: String(pick(r, "bond_wei", 10) ?? "0"),
    status: Number(pick(r, "status", 11) ?? 0),
    ruling: String(pick(r, "ruling", 12) ?? "") as Ruling,
    verifiedRecycledPct: Number(pick(r, "verified_recycled_pct", 13) ?? 0),
    recycledPctT1: Number(pick(r, "recycled_pct_t1", 14) ?? 0),
    recycledPctT2: Number(pick(r, "recycled_pct_t2", 15) ?? 0),
    massBalanceOk: Boolean(pick(r, "mass_balance_ok", 16) ?? false),
    labelIssued: Boolean(pick(r, "label_issued", 17) ?? false),
    rationale: String(pick(r, "rationale", 18) ?? ""),
    sybilDensity: Number(pick(r, "sybil_density", 19) ?? 0),
    registeredEpoch: Number(pick(r, "registered_epoch", 20) ?? 0),
    auditedEpoch: Number(pick(r, "audited_epoch", 21) ?? 0),
    labeledEpoch: Number(pick(r, "labeled_epoch", 22) ?? 0),
    ancestorFlagSource: Number(pick(r, "ancestor_flag_source", 23) ?? 0),
  };
}

export async function getLotsByMaterial(material: string): Promise<number[]> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "get_lots_by_material",
    args: [material],
  });
  return numArr(r);
}

export async function getLotsByRegion(region: string): Promise<number[]> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "get_lots_by_region",
    args: [region],
  });
  return numArr(r);
}

export async function getMaterialRegionDensity(material: string, region: string): Promise<number> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "get_material_region_density",
    args: [material, region],
  });
  return Number(r) || 0;
}

export async function getAncestors(lotId: number): Promise<number[]> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "get_ancestors",
    args: [lotId],
  });
  return numArr(r);
}

export async function getDescendants(lotId: number): Promise<number[]> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "get_descendants",
    args: [lotId],
  });
  return numArr(r);
}

export async function listLots(): Promise<number[]> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "list_lots",
    args: [],
  });
  return numArr(r);
}

export async function getPoolBalance(): Promise<string> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "get_pool_balance",
    args: [],
  });
  return String(r ?? "0");
}

export async function getCounts(): Promise<Counts> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "get_counts",
    args: [],
  });
  const p = String(r).split("||").map((x) => Number(x) || 0);
  return {
    next: p[0] || 0,
    audited: p[1] || 0,
    verified: p[2] || 0,
    rejected: p[3] || 0,
    cascadeFlagged: p[4] || 0,
    totalLabels: p[5] || 0,
    epoch: p[6] || 0,
  };
}

// ── Aggregate loaders ─────────────────────────────────────────────────────-
export async function listAll(maxRows = 200): Promise<LotRow[]> {
  const ids = await listLots();
  if (ids.length === 0) return [];
  const slice = ids.slice(-maxRows);
  const rows = await Promise.all(
    slice.map(async (id) => {
      try {
        const c = await getLot(id);
        return { id, ...c };
      } catch {
        return null;
      }
    })
  );
  return rows.filter((r): r is LotRow => r !== null);
}

// ── Local mass-balance preview (mirrors verify_mass_balance) ────────────────
// Runs the deterministic math client-side BEFORE the user signs the tx.
export function previewMassBalance(lot: LotView, byId: Map<number, LotView>): MassBalanceResult {
  const claimed = lot.claimedRecycledMassKg;
  let capacity = 0;
  const parents: MassBalanceResult["parents"] = [];

  if (lot.parentLotIds.length === 0) {
    capacity = lot.lotMassKg;
  } else {
    for (const pid of lot.parentLotIds) {
      const p = byId.get(pid);
      const pStatus = p ? p.status : -1;
      let contributed = 0;
      if (p) {
        if (pStatus === ST_REJECTED || pStatus === ST_FLAGGED) {
          // contract errors out — represent as zero + fail flag downstream.
          contributed = 0;
        } else if (
          pStatus === ST_LABELED ||
          pStatus === ST_AUDITED_T2 ||
          pStatus === ST_AUDITED_T1
        ) {
          contributed = Math.floor((p.lotMassKg * p.verifiedRecycledPct) / 100);
        } else {
          contributed = p.claimedRecycledMassKg;
        }
      }
      capacity += contributed;
      parents.push({ parentId: pid, contributedKg: contributed, parentStatus: pStatus });
    }
  }

  const blocked = parents.some(
    (p) => p.parentStatus === ST_REJECTED || p.parentStatus === ST_FLAGGED
  );
  const ok = !blocked && claimed <= capacity + MASS_BALANCE_TOLERANCE_KG;
  return {
    lotId: lot.lotId,
    massBalanceOk: ok,
    claimedRecycledKg: claimed,
    parentCapacityKg: capacity,
    parents,
  };
}
