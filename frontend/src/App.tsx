import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import {
  Recycle,
  Lightning,
  Warning,
  Path,
  Barcode as BarcodeIcon,
  Scales,
  ShieldCheck,
  Stack,
  Package,
  TreeStructure,
  Plus,
  Minus,
  ArrowRight,
  SealCheck,
} from "@phosphor-icons/react";
import {
  listAll,
  getCounts,
  getPoolBalance,
  getMaterialRegionDensity,
  previewMassBalance,
  registerLot,
  submitTrace,
  verifyMassBalance,
  adjudicate,
  adjudicateDeep,
  issueLabel,
  cascadeFlagDescendants,
  advanceEpoch,
  setAdmin,
  requiredBondWei,
  weiToGen,
  STATUS_LABEL,
  HIGH_VALUE_LOT_KG,
  MASS_BALANCE_TOLERANCE_KG,
  MAX_PARENT_LOTS,
  ST_REGISTERED,
  ST_TRACED,
  ST_BALANCE_OK,
  ST_AUDITED_T1,
  ST_AUDITED_T2,
  ST_LABELED,
  ST_REJECTED,
  ST_FLAGGED,
  type LotRow,
  type LotView,
  type Counts,
} from "./contractService";

type Hex = `0x${string}`;

// ── Formatting ─────────────────────────────────────────────────────────────
const NB = "\u202f"; // narrow no-break space (thousands separator)
function fmtKg(n: number): string {
  return Math.round(n).toLocaleString("en-US").replace(/,/g, NB) + NB + "kg";
}
function fmtMass(n: number): string {
  const kg = fmtKg(n);
  if (n >= 1000) {
    const t = (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1);
    return `${kg} (${t}${NB}t)`;
  }
  return kg;
}
function short(a: string): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// ── Ruling / status palette ─────────────────────────────────────────────────
interface NodeStyle {
  fill: string;
  hatch: boolean;
  lightning: boolean;
  caption: string;
}
function nodeStyle(lot: LotView): NodeStyle {
  // cascade-flagged → crosshatched
  if (lot.status === ST_FLAGGED || lot.ruling === "DEPENDENCY_FLAGGED") {
    return { fill: "#cfcfcf", hatch: true, lightning: false, caption: "FLAGGED" };
  }
  if (lot.ruling === "MASS_BALANCE_FAIL") {
    return { fill: "#7c130c", hatch: false, lightning: true, caption: "MASS_BALANCE_FAIL" };
  }
  if (lot.ruling === "GREENWASH") {
    return { fill: "#a33632", hatch: false, lightning: false, caption: "GREENWASH" };
  }
  if (lot.ruling === "PARTIAL") {
    return { fill: "#6b7a2e", hatch: false, lightning: false, caption: "PARTIAL" };
  }
  if (lot.ruling === "VERIFIED") {
    return { fill: "#1f7a4d", hatch: false, lightning: false, caption: "VERIFIED" };
  }
  if (lot.status === ST_BALANCE_OK) {
    return { fill: "#b8740a", hatch: false, lightning: false, caption: "BALANCE_OK" };
  }
  return { fill: "#9a9a9a", hatch: false, lightning: false, caption: STATUS_LABEL[lot.status] ?? "—" };
}
function pillColor(lot: LotView): string {
  return nodeStyle(lot).fill;
}

// ── 1D barcode (lot_id encoded as bars) ──────────────────────────────────────
function barcodeBits(value: number, n: number): number[] {
  let r = (value * 2654435761 + 17) >>> 0;
  const bits: number[] = [];
  for (let i = 0; i < n; i++) {
    r = (r * 1103515245 + 12345) >>> 0;
    bits.push((r >> 16) & 1);
  }
  return bits;
}
function Barcode({ value, width = 150, height = 26 }: { value: number; width?: number; height?: number }) {
  const modules = 46;
  const bits = barcodeBits(value, modules);
  const mw = width / modules;
  return (
    <svg className="barcode" width={width} height={height} role="img" aria-label={`barcode lot ${value}`}>
      {bits.map((b, i) =>
        b ? <rect key={i} x={i * mw} y={0} width={mw} height={height - 9} fill="#161616" /> : null
      )}
      <text x={0} y={height - 1} fontFamily="Space Mono, monospace" fontSize={9} fill="#161616">
        LOT*{String(value).padStart(5, "0")}*
      </text>
    </svg>
  );
}

// ── DAG layout ───────────────────────────────────────────────────────────────
interface NodePos {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}
function depthOf(id: number, byId: Map<number, LotView>, memo: Map<number, number>, stack: Set<number>): number {
  const cached = memo.get(id);
  if (cached !== undefined) return cached;
  if (stack.has(id)) return 0;
  const lot = byId.get(id);
  if (!lot || lot.parentLotIds.length === 0) {
    memo.set(id, 0);
    return 0;
  }
  stack.add(id);
  let d = 0;
  for (const p of lot.parentLotIds) {
    d = Math.max(d, depthOf(p, byId, memo, stack) + 1);
  }
  stack.delete(id);
  memo.set(id, d);
  return d;
}

const COL_GAP = 210;
const ROW_GAP = 96;
const NODE_W = 150;
const PAD = 30;

function layoutDag(rows: LotRow[], byId: Map<number, LotView>) {
  const memo = new Map<number, number>();
  const cols = new Map<number, LotRow[]>();
  let maxMass = 1;
  for (const r of rows) maxMass = Math.max(maxMass, r.lotMassKg);
  for (const r of rows) {
    const d = depthOf(r.lotId, byId, memo, new Set());
    if (!cols.has(d)) cols.set(d, []);
    cols.get(d)!.push(r);
  }
  const positions = new Map<number, NodePos>();
  let maxDepth = 0;
  let maxRowsInCol = 0;
  const sortedDepths = [...cols.keys()].sort((a, b) => a - b);
  for (const d of sortedDepths) {
    maxDepth = Math.max(maxDepth, d);
    const list = cols.get(d)!.sort((a, b) => a.lotId - b.lotId);
    maxRowsInCol = Math.max(maxRowsInCol, list.length);
    list.forEach((r, idx) => {
      const h = 34 + Math.round((r.lotMassKg / maxMass) * 40);
      const x = PAD + d * COL_GAP;
      const y = PAD + idx * ROW_GAP;
      positions.set(r.lotId, { id: r.lotId, x, y, w: NODE_W, h, cx: x + NODE_W / 2, cy: y + h / 2 });
    });
  }
  const width = PAD * 2 + maxDepth * COL_GAP + NODE_W;
  const height = PAD * 2 + Math.max(1, maxRowsInCol) * ROW_GAP;
  return { positions, width, height };
}

// ── DAG canvas component ─────────────────────────────────────────────────────
function DagCanvas({
  rows,
  byId,
  selectedId,
  onSelect,
}: {
  rows: LotRow[];
  byId: Map<number, LotView>;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const { positions, width, height } = useMemo(() => layoutDag(rows, byId), [rows, byId]);
  if (rows.length === 0) return <div className="empty">No lots registered yet — the DAG is empty.</div>;

  const edges: { key: string; d: string; caretX: number; caretY: number }[] = [];
  for (const r of rows) {
    const cp = positions.get(r.lotId);
    if (!cp) continue;
    for (const pid of r.parentLotIds) {
      const pp = positions.get(pid);
      if (!pp) continue;
      const x1 = pp.x + pp.w;
      const y1 = pp.cy;
      const x2 = cp.x;
      const y2 = cp.cy;
      const midX = (x1 + x2) / 2;
      // right-angle bracket edge: H to midX, V to child row, H into child
      const d = `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
      edges.push({ key: `${pid}-${r.lotId}`, d, caretX: x2, caretY: y2 });
    }
  }

  return (
    <div className="dag-wrap">
      <svg className="dag-svg" width={Math.max(width, 320)} height={Math.max(height, 160)}>
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#cfcfcf" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#161616" strokeWidth="2" />
          </pattern>
        </defs>
        {/* edges first */}
        {edges.map((e) => (
          <g key={e.key}>
            <path className="dag-edge" d={e.d} />
            {/* open caret ">" arrowhead pointing into child */}
            <path
              className="dag-edge"
              d={`M ${e.caretX - 9} ${e.caretY - 5} L ${e.caretX} ${e.caretY} L ${e.caretX - 9} ${e.caretY + 5}`}
            />
          </g>
        ))}
        {/* nodes */}
        {rows.map((r) => {
          const p = positions.get(r.lotId);
          if (!p) return null;
          const st = nodeStyle(r);
          const sel = selectedId === r.lotId;
          return (
            <g
              key={r.lotId}
              className={`dag-node-box${sel ? " sel" : ""}`}
              transform={`translate(${p.x},${p.y})`}
              onClick={() => onSelect(r.lotId)}
            >
              <rect className="node-rect" width={p.w} height={p.h} fill={st.hatch ? "url(#hatch)" : st.fill} />
              <text className="dag-node-label" x={8} y={16} fill={st.hatch ? "#161616" : "#fff"}>
                #{r.lotId} {st.lightning ? "⚡" : ""}
              </text>
              <text
                x={8}
                y={p.h - 8}
                fontFamily="Space Mono, monospace"
                fontSize={9}
                fill={st.hatch ? "#161616" : "#fff"}
              >
                {fmtKg(r.lotMassKg)}
              </text>
              <text
                x={p.w - 6}
                y={16}
                textAnchor="end"
                fontFamily="Space Mono, monospace"
                fontSize={9}
                fill={st.hatch ? "#161616" : "#fff"}
              >
                {st.caption.slice(0, 9)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="dag-legend">
        {[
          ["#9a9a9a", "registered/traced", false, false],
          ["#b8740a", "balance_ok", false, false],
          ["#1f7a4d", "verified", false, false],
          ["#6b7a2e", "partial", false, false],
          ["#a33632", "greenwash", false, false],
          ["#7c130c", "mass_balance_fail ⚡", false, true],
          ["#cfcfcf", "flagged (cascade)", true, false],
        ].map(([c, label, hatch], i) => (
          <span className="li" key={i}>
            <i
              className="swatch"
              style={{ background: hatch ? "repeating-linear-gradient(45deg,#cfcfcf,#cfcfcf 2px,#161616 2px,#161616 4px)" : (c as string) }}
            />
            {label as string}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Ancestor / mass-balance helpers ──────────────────────────────────────────
function collectAncestors(lot: LotView, byId: Map<number, LotView>): LotView[] {
  const seen = new Set<number>();
  const out: LotView[] = [];
  const q = [...lot.parentLotIds];
  while (q.length) {
    const id = q.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const p = byId.get(id);
    if (p) {
      out.push(p);
      q.push(...p.parentLotIds);
    }
  }
  return out;
}

// ── App ──────────────────────────────────────────────────────────────────────
export function App() {
  const { address, isConnected } = useAccount();
  const acct = address as Hex | undefined;

  const [rows, setRows] = useState<LotRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [pool, setPool] = useState<string>("0");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [adminMode, setAdminMode] = useState(false);
  const [entered, setEntered] = useState(false);

  const byId = useMemo(() => {
    const m = new Map<number, LotView>();
    for (const r of rows) m.set(r.lotId, r);
    return m;
  }, [rows]);

  const selected = selectedId !== null ? byId.get(selectedId) ?? null : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c, p] = await Promise.all([listAll(), getCounts(), getPoolBalance()]);
      setRows(r);
      setCounts(c);
      setPool(p);
    } catch (e: any) {
      setErr(`Load failed: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = useCallback(
    async (tag: string, fn: () => Promise<void>) => {
      if (!acct) {
        setErr("Connect a wallet first.");
        return;
      }
      setBusy(tag);
      setErr(null);
      setOk(null);
      try {
        await fn();
        setOk(`${tag} — accepted.`);
        await load();
      } catch (e: any) {
        setErr(`${tag} failed: ${e?.shortMessage ?? e?.message ?? e}`);
      } finally {
        setBusy(null);
      }
    },
    [acct, load]
  );

  if (!entered) {
    return <Landing onEnter={() => setEntered(true)} />;
  }

  return (
    <>
      {/* Header / manifest plate */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Recycle size={26} weight="bold" />
          </span>
          <div>
            <h1>RECUR</h1>
            <div className="sub">Recycled-content manifest · supply-chain DAG</div>
          </div>
        </div>
        <div className="topbar-right">
          <button
            className="btn-back"
            type="button"
            onClick={() => setEntered(false)}
            title="Return to the overview / landing manifest"
            aria-label="Back to overview"
          >
            <span className="btn-back-arrow" aria-hidden="true">←</span>
            <span className="btn-back-label">Manifest</span>
          </button>
          <span className="addr-chip" title="deployed contract (Studionet)">
            0x9C7C…0145
          </span>
          <ConnectButton showBalance={false} chainStatus="icon" />
        </div>
      </header>

      {/* Counters strip */}
      <div className="manifest">
        {[
          ["LOTS", counts?.next ?? 0],
          ["AUDITED", counts?.audited ?? 0],
          ["VERIFIED", counts?.verified ?? 0],
          ["REJECTED", counts?.rejected ?? 0],
          ["CASCADE-FLAGGED", counts?.cascadeFlagged ?? 0],
          ["LABELS", counts?.totalLabels ?? 0],
          ["EPOCH", counts?.epoch ?? 0],
        ].map(([k, v]) => (
          <div className="cell" key={k as string}>
            <div className="v">{String(v)}</div>
            <div className="k">{k as string}</div>
          </div>
        ))}
      </div>

      {err && <div className="notice err">{err}</div>}
      {ok && <div className="notice ok">{ok}</div>}

      <div className="layout">
        {/* ── Main column ── */}
        <div>
          <div className="panel">
            <div className="head">
              <span className="t">
                <Path size={13} weight="bold" style={{ verticalAlign: "-2px", marginRight: 6 }} />
                Supply-chain DAG
              </span>
              <span className="hint">
                {loading ? <span className="spin" /> : `roots → descendants · ${rows.length} nodes`}
              </span>
            </div>
            <DagCanvas rows={rows} byId={byId} selectedId={selectedId} onSelect={setSelectedId} />
          </div>

          <RegisterPanel
            rows={rows}
            disabled={!isConnected}
            busy={busy === "register_lot"}
            onSubmit={(form, bondWei) =>
              run("register_lot", async () => {
                const id = await registerLot(acct!, { ...form, bondWei });
                setSelectedId(id);
              })
            }
          />

          <div className="section-title">
            <BarcodeIcon size={13} weight="bold" style={{ verticalAlign: "-2px", marginRight: 6 }} />
            Lot register · shipping labels
          </div>
          {rows.length === 0 ? (
            <div className="empty">No lots yet.</div>
          ) : (
            <div className="lotlist">
              {[...rows]
                .sort((a, b) => b.lotId - a.lotId)
                .map((r) => {
                  const st = nodeStyle(r);
                  return (
                    <div
                      key={r.lotId}
                      className={`ship-label${selectedId === r.lotId ? " sel" : ""}`}
                      onClick={() => setSelectedId(r.lotId)}
                    >
                      <div className="ribbon" style={{ background: st.hatch ? "#cfcfcf" : st.fill }} />
                      <div className="row1">
                        <span className="lotid">#{String(r.lotId).padStart(4, "0")}</span>
                        <span className="pill" style={{ background: st.hatch ? "#cfcfcf" : st.fill, color: st.hatch ? "#161616" : "#fff" }}>
                          {st.lightning ? "⚡ " : ""}
                          {st.caption}
                        </span>
                      </div>
                      <div className="lbl">{r.publicLabel || "(unlabelled)"}</div>
                      <div className="meta">
                        <span>MAT {r.material}</span>
                        <span>REG {r.region}</span>
                        <span>{fmtMass(r.lotMassKg)}</span>
                        <span>REC {r.claimedRecycledMassKg.toLocaleString("en-US").replace(/,/g, NB)} kg</span>
                        {r.parentLotIds.length > 0 && <span>↶ {r.parentLotIds.length} parent(s)</span>}
                      </div>
                      <Barcode value={r.lotId} />
                    </div>
                  );
                })}
            </div>
          )}

          {/* Admin / keeper */}
          <AdminPanel
            adminMode={adminMode}
            setAdminMode={setAdminMode}
            disabled={!isConnected}
            poolGen={weiToGen(BigInt(pool || "0"))}
            busyEpoch={busy === "advance_epoch"}
            busyAdmin={busy === "set_admin"}
            onAdvance={() => run("advance_epoch", () => advanceEpoch(acct!))}
            onSetAdmin={(a) => run("set_admin", () => setAdmin(acct!, a))}
          />
        </div>

        {/* ── Detail rail ── */}
        <div className="rail">
          {selected ? (
            <DetailRail
              lot={selected}
              byId={byId}
              acct={acct}
              adminMode={adminMode}
              busy={busy}
              onAction={run}
            />
          ) : (
            <div className="panel">
              <div className="head">
                <span className="t">Lot detail</span>
              </div>
              <div className="body empty">Select a node in the DAG or a shipping label to inspect the lot, run the mass-balance preview, and act.</div>
            </div>
          )}
        </div>
      </div>

      <div className="foot">
        <span>RECUR · Atlas dApp #5 · GenLayer Studionet</span>
        <span>Mass-balance tolerance ±{MASS_BALANCE_TOLERANCE_KG} kg · T2 mandatory ≥ {fmtKg(HIGH_VALUE_LOT_KG)}</span>
      </div>
    </>
  );
}

// ── Landing screen ────────────────────────────────────────────────────────--
const STEPS: { n: string; icon: JSX.Element; title: string; body: string }[] = [
  {
    n: "01",
    icon: <Package size={22} weight="bold" />,
    title: "Register a material lot + post a bond",
    body:
      "File a lot on the registry: a public label, the material (e.g. PET, aluminium), the region, the total lot mass in kg and the claimed recycled mass. Name its parent lots — the upstream lots that materially fed into it — by id. Each lot is payable: you post a refundable GEN bond that scales with how dense the (material, region) cell already is, so spamming claims into a hot cell costs progressively more.",
  },
  {
    n: "02",
    icon: <TreeStructure size={22} weight="bold" />,
    title: "Build the supply-chain DAG",
    body:
      "Every lot becomes a node in a directed acyclic graph; an edge runs from each parent into the child. Lots with no parents are raw collection lots — the only roots of the graph. You then submit a supply-chain trace: certificates, chain-of-custody facts, audit dates and mass-balance figures that document where the recycled content actually came from.",
  },
  {
    n: "03",
    icon: <Scales size={22} weight="bold" />,
    title: "Mass-balance verification (before any LLM)",
    body:
      "A recycled-content claim is never judged in isolation. The contract first runs deterministic on-chain math: a child lot's claimed recycled mass may not exceed the summed recycled capacity of its parents (a root lot is bounded by its own lot mass), within a 5 kg tolerance. Only if the balance holds does the two-tier LLM audit run — fast T1 first, then a mandatory deep T2 for high-value lots ≥ 5 t — scoring the trace against each parent's verified history.",
  },
  {
    n: "04",
    icon: <ShieldCheck size={22} weight="bold" />,
    title: "Adjudication + cascade flag",
    body:
      "On settlement the bond is refunded and a VERIFIED lot earns a premium eco-label; a GREENWASH ruling slashes the bond. And because trust flows down the graph, if any ancestor is later overturned, cascade_flag_descendants walks the child DAG and flags every downstream lot as DEPENDENCY_FLAGGED — revoking the labels they had until they are re-audited.",
  },
];

const FAQS: { q: string; a: string }[] = [
  {
    q: "Do I need real money? What is the bond?",
    a: "No real money. Recur runs on the GenLayer Studionet testnet, so you fund your wallet with free test GEN. Registering a lot is payable: you post a refundable bond starting at 0.005 GEN that scales up with the density of the (material, region) cell you are claiming into. The bond is returned when your lot clears, and slashed into the pool if the lot is ruled GREENWASH.",
  },
  {
    q: "What is a lot, and what is the DAG?",
    a: "A lot is a single batch of recycled material — a node in the registry. Its parent lots are the upstream batches that fed into it, drawn as edges from parent to child. Together every lot and edge form a directed acyclic graph (DAG). Lots with no parents are raw collection lots: the roots from which all recycled-content claims descend.",
  },
  {
    q: "What does the mass-balance check actually verify?",
    a: "It is pure deterministic on-chain arithmetic that runs before any LLM sees the dossier. For each parent it takes the recycled mass that parent has verified (or, for raw roots, the lot's own mass) and sums it into a parent capacity. The lot passes only if its claimed recycled mass is less than or equal to that capacity plus a 5 kg rounding tolerance. If you claim more recycled content than your parents can physically supply, it fails as MASS_BALANCE_FAIL and is rejected.",
  },
  {
    q: "What does a cascade flag do?",
    a: "Trust in this graph is inherited. If an ancestor lot is rejected or overturned, every lot downstream of it is now suspect. Calling cascade_flag_descendants on that ancestor walks the child DAG breadth-first and marks each still-live descendant as DEPENDENCY_FLAGGED, recording which ancestor caused it. Any eco-labels those descendants held are revoked until they are re-traced and re-adjudicated.",
  },
  {
    q: "What does a label / certificate mean?",
    a: "The label is the outcome of the LLM audit. A lot scoring VERIFIED (≥ 80% verified recycled content) is issued the premium eco-label and its bond is refunded. A PARTIAL lot clears and recovers its bond but earns no label. A GREENWASH lot gets no label and its bond is slashed. High-value lots ≥ 5 t must pass the deep T2 audit before any label can be issued.",
  },
  {
    q: "Who can advance the epoch?",
    a: "Only the contract admin can advance the epoch — it is the registry's audit-trail clock, stamping when lots are registered, audited and labelled. Admin-only transactions revert for any other key. Anyone, by contrast, can trigger the public steps: verify a mass balance, run an adjudication, issue a label, or cascade-flag descendants.",
  },
];

function FaqItem({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle: () => void }) {
  return (
    <div className={`faq-item${open ? " open" : ""}`}>
      <button className="faq-q" onClick={onToggle} aria-expanded={open}>
        <span>{q}</span>
        {open ? <Minus size={16} weight="bold" /> : <Plus size={16} weight="bold" />}
      </button>
      {open && <div className="faq-a">{a}</div>}
    </div>
  );
}

function Landing({ onEnter }: { onEnter: () => void }) {
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  return (
    <div className="landing">
      {/* Header plate */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Recycle size={26} weight="bold" />
          </span>
          <div>
            <h1>RECUR</h1>
            <div className="sub">Recycled-content manifest · supply-chain DAG</div>
          </div>
        </div>
        <div className="topbar-right">
          <span className="addr-chip" title="deployed contract (Studionet)">
            0x9C7C…0145
          </span>
          <ConnectButton showBalance={false} chainStatus="icon" />
        </div>
      </header>

      {/* Hero / manifest declaration */}
      <section className="lp-hero">
        <div className="lp-hero-main">
          <div className="lp-tag">
            <span className="lp-tag-box">FORM RV-5</span>
            <span>POST-CONSUMER RECYCLED-CONTENT REGISTRY · ATLAS dApp #5</span>
          </div>
          <h2 className="lp-headline">
            Prove the recycled content. <br />
            Verify the whole chain.
          </h2>
          <p className="lp-lede">
            Recur registers every recycled-material lot as a node in a supply-chain DAG and
            checks the mass balance across that graph <em>before</em> any AI judges the claim — a
            lot can never declare more recycled mass than its parents can physically supply. When an
            upstream lot is overturned, the suspicion cascades to every descendant.
          </p>
          <div className="lp-cta-row">
            <button className="btn hivis lp-cta" onClick={onEnter}>
              <Barcode value={5} width={54} height={18} />
              REGISTER A LOT
              <ArrowRight size={18} weight="bold" />
            </button>
            <button className="btn lp-cta-2" onClick={onEnter}>
              ENTER MANIFEST
            </button>
          </div>
        </div>
        <aside className="lp-hero-spec">
          <div className="lp-spec-head">
            <SealCheck size={15} weight="bold" style={{ verticalAlign: "-3px", marginRight: 6 }} />
            VERIFICATION SPEC
          </div>
          <dl className="lp-spec-list">
            <dt>Mass-balance</dt>
            <dd>deterministic · pre-LLM</dd>
            <dt>Tolerance</dt>
            <dd>±{MASS_BALANCE_TOLERANCE_KG} kg</dd>
            <dt>Audit tiers</dt>
            <dd>T1 fast · T2 deep</dd>
            <dt>T2 mandatory</dt>
            <dd>≥ {fmtKg(HIGH_VALUE_LOT_KG)}</dd>
            <dt>Max parents</dt>
            <dd>{MAX_PARENT_LOTS} / lot</dd>
            <dt>Base bond</dt>
            <dd>0.005 GEN</dd>
            <dt>Network</dt>
            <dd>GenLayer Studionet</dd>
          </dl>
          <div className="lp-spec-barcode">
            <Barcode value={51999} width={200} height={28} />
          </div>
        </aside>
      </section>

      {/* How it works — 4 steps */}
      <div className="section-title">
        <Path size={13} weight="bold" style={{ verticalAlign: "-2px", marginRight: 6 }} />
        How it works · four stamps to a verified label
      </div>
      <div className="lp-steps">
        {STEPS.map((s) => (
          <div className="lp-step" key={s.n}>
            <div className="lp-step-top">
              <span className="lp-step-n">{s.n}</span>
              <span className="lp-step-icon">{s.icon}</span>
            </div>
            <div className="lp-step-title">{s.title}</div>
            <p className="lp-step-body">{s.body}</p>
          </div>
        ))}
      </div>

      {/* Ruling legend strip */}
      <div className="lp-rulings">
        {[
          ["#1f7a4d", "VERIFIED", "premium label issued"],
          ["#6b7a2e", "PARTIAL", "clears · no label"],
          ["#a33632", "GREENWASH", "bond slashed"],
          ["#7c130c", "MASS_BALANCE_FAIL", "claim exceeds parents"],
          ["#cfcfcf", "FLAGGED", "ancestor overturned"],
        ].map(([c, k, d]) => (
          <div className="lp-ruling" key={k as string}>
            <i className="swatch" style={{ background: c as string }} />
            <div>
              <div className="lp-ruling-k">{k as string}</div>
              <div className="lp-ruling-d">{d as string}</div>
            </div>
          </div>
        ))}
      </div>

      {/* FAQ accordion */}
      <div className="section-title">
        <Warning size={13} weight="bold" style={{ verticalAlign: "-2px", marginRight: 6 }} />
        Manifest FAQ
      </div>
      <div className="faq">
        {FAQS.map((f, i) => (
          <FaqItem
            key={i}
            q={f.q}
            a={f.a}
            open={openFaq === i}
            onToggle={() => setOpenFaq((cur) => (cur === i ? null : i))}
          />
        ))}
      </div>

      {/* Final CTA */}
      <div className="lp-final">
        <div>
          <div className="lp-final-k">READY TO FILE?</div>
          <div className="lp-final-sub">
            Connect a wallet, register your first lot, and watch it move through the DAG.
          </div>
        </div>
        <button className="btn hivis lp-cta" onClick={onEnter}>
          ENTER MANIFEST
          <ArrowRight size={18} weight="bold" />
        </button>
      </div>

      <div className="foot">
        <span>RECUR · Atlas dApp #5 · GenLayer Studionet</span>
        <span>Mass-balance tolerance ±{MASS_BALANCE_TOLERANCE_KG} kg · T2 mandatory ≥ {fmtKg(HIGH_VALUE_LOT_KG)}</span>
      </div>
    </div>
  );
}

// ── Detail rail ──────────────────────────────────────────────────────────────
function DetailRail({
  lot,
  byId,
  acct,
  adminMode,
  busy,
  onAction,
}: {
  lot: LotView;
  byId: Map<number, LotView>;
  acct: Hex | undefined;
  adminMode: boolean;
  busy: string | null;
  onAction: (tag: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const [trace, setTrace] = useState("");
  useEffect(() => {
    setTrace("");
  }, [lot.lotId]);

  const isClaimant = !!acct && acct.toLowerCase() === lot.claimant.toLowerCase();
  const st = nodeStyle(lot);
  const preview = useMemo(() => previewMassBalance(lot, byId), [lot, byId]);
  const ancestors = useMemo(() => collectAncestors(lot, byId), [lot, byId]);
  const flaggedAncestors = ancestors.filter((a) => a.status === ST_REJECTED || a.status === ST_FLAGGED);
  const highValue = lot.lotMassKg >= HIGH_VALUE_LOT_KG;

  const can = {
    trace: lot.status === ST_REGISTERED && isClaimant,
    verify: lot.status === ST_TRACED,
    t1: lot.status === ST_BALANCE_OK,
    t2: lot.status === ST_AUDITED_T1 && (isClaimant || adminMode),
    label:
      (lot.status === ST_AUDITED_T2 || (lot.status === ST_AUDITED_T1 && !highValue)),
    cascade: lot.status === ST_REJECTED || lot.status === ST_FLAGGED,
  };
  const tol = MASS_BALANCE_TOLERANCE_KG;

  return (
    <>
      {flaggedAncestors.length > 0 && (
        <div className="cascade-banner">
          <Warning className="hz" size={26} weight="fill" />
          <span>
            {flaggedAncestors.length} ancestor(s) are flagged — this lot is currently under suspicion.
            {lot.ancestorFlagSource > 0 && ` Flag source: lot #${lot.ancestorFlagSource}.`}
          </span>
        </div>
      )}

      <div className="panel">
        <div className="head">
          <span className="t">Lot #{lot.lotId}</span>
          <span className="pill" style={{ background: st.hatch ? "#cfcfcf" : pillColor(lot), color: st.hatch ? "#161616" : "#fff" }}>
            {st.lightning ? "⚡ " : ""}
            {st.caption}
          </span>
        </div>
        <div className="body">
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>{lot.publicLabel || "(unlabelled)"}</div>
          <dl className="kv">
            <dt>Material</dt>
            <dd>{lot.material}</dd>
            <dt>Region</dt>
            <dd>{lot.region}</dd>
            <dt>Lot mass</dt>
            <dd>{fmtMass(lot.lotMassKg)}</dd>
            <dt>Claimed recycled</dt>
            <dd>{fmtKg(lot.claimedRecycledMassKg)}</dd>
            <dt>Verified pct</dt>
            <dd>{lot.verifiedRecycledPct}%{lot.recycledPctT2 > 0 ? ` (T1 ${lot.recycledPctT1}% → T2 ${lot.recycledPctT2}%)` : lot.recycledPctT1 > 0 ? ` (T1 ${lot.recycledPctT1}%)` : ""}</dd>
            <dt>Parents</dt>
            <dd>{lot.parentLotIds.length ? lot.parentLotIds.map((p) => `#${p}`).join(" ") : "— root lot"}</dd>
            <dt>Children</dt>
            <dd>{lot.childLotIds.length ? lot.childLotIds.map((c) => `#${c}`).join(" ") : "—"}</dd>
            <dt>Claimant</dt>
            <dd title={lot.claimant}>{short(lot.claimant)}{isClaimant ? " (you)" : ""}</dd>
            <dt>Bond</dt>
            <dd>{weiToGen(BigInt(lot.bondWei || "0"))} GEN{lot.bondWei === "0" ? " (settled)" : ""}</dd>
            <dt>Sybil density</dt>
            <dd>{lot.sybilDensity}</dd>
            <dt>Label issued</dt>
            <dd>{lot.labelIssued ? "YES ✓" : "no"}</dd>
          </dl>
          {lot.rationale && (
            <>
              <div className="label" style={{ margin: "10px 0 4px" }}>Audit rationale</div>
              <div className="rationale">{lot.rationale}</div>
            </>
          )}
        </div>
      </div>

      {/* Mass-balance breakdown */}
      <div className="panel">
        <div className="head">
          <span className="t">
            <Scales size={13} weight="bold" style={{ verticalAlign: "-2px", marginRight: 6 }} />
            Mass-balance breakdown
          </span>
          <span className="hint">{lot.massBalanceOk ? "on-chain: OK" : "local preview"}</span>
        </div>
        <div className="body" style={{ padding: 0 }}>
          <div className="mb">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>mass × pct/100</th>
                  <th>kg</th>
                </tr>
              </thead>
              <tbody>
                {lot.parentLotIds.length === 0 ? (
                  <tr>
                    <td>root (lot mass)</td>
                    <td>{fmtKg(lot.lotMassKg)} × 100/100</td>
                    <td>{Math.round(lot.lotMassKg).toLocaleString("en-US").replace(/,/g, NB)}</td>
                  </tr>
                ) : (
                  preview.parents.map((p) => {
                    const par = byId.get(p.parentId);
                    const usesVerified =
                      par &&
                      (par.status === ST_LABELED || par.status === ST_AUDITED_T2 || par.status === ST_AUDITED_T1);
                    const expr = par
                      ? usesVerified
                        ? `${Math.round(par.lotMassKg)} × ${par.verifiedRecycledPct}/100`
                        : `claimed ${Math.round(par.claimedRecycledMassKg)}`
                      : "missing";
                    return (
                      <tr key={p.parentId}>
                        <td>#{p.parentId} {par ? par.material : ""}</td>
                        <td>{expr}</td>
                        <td>{p.contributedKg.toLocaleString("en-US").replace(/,/g, NB)}</td>
                      </tr>
                    );
                  })
                )}
                <tr className="total">
                  <td>Parent capacity</td>
                  <td>+ tolerance {tol} kg</td>
                  <td>{(preview.parentCapacityKg + tol).toLocaleString("en-US").replace(/,/g, NB)}</td>
                </tr>
                <tr className="total">
                  <td>Claimed recycled</td>
                  <td></td>
                  <td>{preview.claimedRecycledKg.toLocaleString("en-US").replace(/,/g, NB)}</td>
                </tr>
              </tbody>
            </table>
            <div className={`mb-verdict ${preview.massBalanceOk ? "ok" : "fail"}`}>
              <span>
                {preview.claimedRecycledKg.toLocaleString("en-US").replace(/,/g, NB)} kg{" "}
                {preview.massBalanceOk ? "≤" : ">"}{" "}
                {(preview.parentCapacityKg + tol).toLocaleString("en-US").replace(/,/g, NB)} kg
              </span>
              <span>{preview.massBalanceOk ? "PASS ✓" : "FAIL ✗"}</span>
            </div>
          </div>
          {can.verify && (
            <div className="body" style={{ borderTop: "2px dashed #161616" }}>
              <div className="label" style={{ marginBottom: 6 }}>
                Preview computed locally · review before signing
              </div>
              <button
                className={`btn ${preview.massBalanceOk ? "hivis" : "danger"}`}
                disabled={busy === "verify_mass_balance"}
                onClick={() => onAction("verify_mass_balance", () => verifyMassBalance(acct!, lot.lotId))}
              >
                {busy === "verify_mass_balance" ? <span className="spin" /> : null} Verify mass balance on-chain
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="panel">
        <div className="head">
          <span className="t">
            <ShieldCheck size={13} weight="bold" style={{ verticalAlign: "-2px", marginRight: 6 }} />
            Actions
          </span>
          {highValue && <span className="hint">high-value · T2 required</span>}
        </div>
        <div className="body">
          {can.trace && (
            <div className="field">
              <label>Supply-chain trace (claimant only)</label>
              <textarea
                value={trace}
                onChange={(e) => setTrace(e.target.value)}
                placeholder="Certificates, mass-balance figures, audit dates, chain-of-custody…"
              />
              <button
                className="btn hivis"
                disabled={busy === "submit_trace" || trace.trim().length < 30}
                onClick={() => onAction("submit_trace", () => submitTrace(acct!, lot.lotId, trace))}
                style={{ marginTop: 6 }}
              >
                {busy === "submit_trace" ? <span className="spin" /> : null} Submit trace
              </button>
            </div>
          )}

          <div className="btn-row">
            {can.t1 && (
              <button
                className="btn"
                disabled={busy === "adjudicate"}
                onClick={() => onAction("adjudicate", () => adjudicate(acct!, lot.lotId))}
              >
                {busy === "adjudicate" ? <span className="spin" /> : null} Adjudicate (T1)
              </button>
            )}
            {lot.status === ST_AUDITED_T1 && (
              <button
                className="btn"
                disabled={busy === "adjudicate_deep" || !can.t2}
                title={can.t2 ? "" : "Claimant or admin only"}
                onClick={() => onAction("adjudicate_deep", () => adjudicateDeep(acct!, lot.lotId))}
              >
                {busy === "adjudicate_deep" ? <span className="spin" /> : null} Adjudicate deep (T2)
              </button>
            )}
            {can.label && (
              <button
                className="btn go"
                disabled={busy === "issue_label"}
                onClick={() => onAction("issue_label", () => issueLabel(acct!, lot.lotId))}
              >
                {busy === "issue_label" ? <span className="spin" /> : null} Issue label / settle bond
              </button>
            )}
            {can.cascade && (
              <button
                className="btn danger"
                disabled={busy === "cascade_flag_descendants"}
                onClick={() =>
                  onAction("cascade_flag_descendants", () => cascadeFlagDescendants(acct!, lot.lotId))
                }
              >
                {busy === "cascade_flag_descendants" ? <span className="spin" /> : null} Cascade-flag descendants
              </button>
            )}
          </div>
          {lot.status === ST_AUDITED_T1 && highValue && (
            <div className="notice">High-value lot (≥ {fmtKg(HIGH_VALUE_LOT_KG)}): T2 deep audit is mandatory before a label can be issued.</div>
          )}
          {lot.status === ST_LABELED && <div className="notice">Lot finalised — bond settled.</div>}
        </div>
      </div>
    </>
  );
}

// ── Registration panel ───────────────────────────────────────────────────────
interface RegForm {
  publicLabel: string;
  material: string;
  region: string;
  lotMassKg: number;
  claimedRecycledMassKg: number;
  parentLotIdsCsv: string;
}
function RegisterPanel({
  rows,
  disabled,
  busy,
  onSubmit,
}: {
  rows: LotRow[];
  disabled: boolean;
  busy: boolean;
  onSubmit: (form: RegForm, bondWei: bigint) => void;
}) {
  const [publicLabel, setPublicLabel] = useState("");
  const [material, setMaterial] = useState("");
  const [region, setRegion] = useState("");
  const [lotMass, setLotMass] = useState("");
  const [claimed, setClaimed] = useState("");
  const [parents, setParents] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [density, setDensity] = useState(0);

  useEffect(() => {
    let cancel = false;
    const m = material.trim();
    const r = region.trim();
    if (!m || !r) {
      setDensity(0);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const d = await getMaterialRegionDensity(m, r);
        if (!cancel) setDensity(d);
      } catch {
        if (!cancel) setDensity(0);
      }
    }, 350);
    return () => {
      cancel = true;
      clearTimeout(t);
    };
  }, [material, region]);

  const bondWei = requiredBondWei(density);
  const lotMassN = Number(lotMass) || 0;
  const claimedN = Number(claimed) || 0;
  const meterPct = Math.min(100, (density / 8) * 100);

  const candidates = rows
    .filter((r) => {
      if (parents.includes(r.lotId)) return false;
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (
        r.material.includes(q) ||
        r.region.toLowerCase().includes(q) ||
        r.publicLabel.toLowerCase().includes(q) ||
        String(r.lotId) === q
      );
    })
    .slice(0, 40);

  const valid =
    publicLabel.trim().length > 0 &&
    material.trim().length > 0 &&
    region.trim().length > 0 &&
    lotMassN > 0 &&
    claimedN >= 0 &&
    claimedN <= lotMassN;

  function submit() {
    onSubmit(
      {
        publicLabel,
        material,
        region,
        lotMassKg: lotMassN,
        claimedRecycledMassKg: claimedN,
        parentLotIdsCsv: parents.join(","),
      },
      bondWei
    );
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="head">
        <span className="t">
          <Stack size={13} weight="bold" style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Register lot
        </span>
        <span className="hint">payable · bond scales with density</span>
      </div>
      <div className="body">
        <div className="field">
          <label>Public label</label>
          <input type="text" value={publicLabel} maxLength={80} onChange={(e) => setPublicLabel(e.target.value)} placeholder="rPET flake batch — Q2" />
        </div>
        <div className="two">
          <div className="field">
            <label>Material</label>
            <input type="text" value={material} onChange={(e) => setMaterial(e.target.value)} placeholder="pet" />
          </div>
          <div className="field">
            <label>Region</label>
            <input type="text" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="eu-west" />
          </div>
        </div>
        <div className="two">
          <div className="field">
            <label>Lot mass (kg)</label>
            <input type="number" min={1} value={lotMass} onChange={(e) => setLotMass(e.target.value)} placeholder="5000" />
          </div>
          <div className="field">
            <label>Claimed recycled (kg)</label>
            <input type="number" min={0} value={claimed} onChange={(e) => setClaimed(e.target.value)} placeholder="4200" />
          </div>
        </div>
        {claimedN > lotMassN && lotMassN > 0 && (
          <div className="notice err">Claimed recycled mass cannot exceed the lot mass.</div>
        )}

        {/* Density meter + bond preview */}
        <div className="label" style={{ margin: "8px 0 4px" }}>
          (material, region) density — {density} existing lot(s)
        </div>
        <div className="meter">
          <i style={{ width: `${meterPct}%` }} />
        </div>
        <div className="notice" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Required bond (sybil-adjusted)</span>
          <strong>{weiToGen(bondWei)} GEN</strong>
        </div>

        {/* Parent picker */}
        <div className="field" style={{ marginTop: 10 }}>
          <label>Parent lots ({parents.length}/{MAX_PARENT_LOTS}) — search by material / region / id</label>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search candidate lots…" />
          <div className="parent-pick" style={{ marginTop: 6 }}>
            {candidates.length === 0 ? (
              <div style={{ padding: 6, fontFamily: "Space Mono, monospace", fontSize: 11, color: "#6e6e6e" }}>
                no matching lots
              </div>
            ) : (
              candidates.map((c) => (
                <div className="pp-row" key={c.lotId}>
                  <span>
                    #{c.lotId} · {c.publicLabel.slice(0, 22) || "(unlabelled)"} · {c.material}/{c.region}
                  </span>
                  <button
                    className="btn"
                    style={{ padding: "2px 8px" }}
                    disabled={parents.length >= MAX_PARENT_LOTS}
                    onClick={() => setParents((p) => [...p, c.lotId])}
                  >
                    add
                  </button>
                </div>
              ))
            )}
          </div>
          {parents.length > 0 && (
            <div className="chosen">
              {parents.map((p) => (
                <span className="tag" key={p} onClick={() => setParents((arr) => arr.filter((x) => x !== p))} title="click to remove">
                  #{p} ✕
                </span>
              ))}
            </div>
          )}
        </div>

        <button className="btn hivis" disabled={disabled || busy || !valid} onClick={submit}>
          {busy ? <span className="spin" /> : null} Register lot · post {weiToGen(bondWei)} GEN bond
        </button>
        {disabled && <div className="notice">Connect a wallet to register.</div>}
      </div>
    </div>
  );
}

// ── Admin / keeper panel ──────────────────────────────────────────────────────
function AdminPanel({
  adminMode,
  setAdminMode,
  disabled,
  poolGen,
  busyEpoch,
  busyAdmin,
  onAdvance,
  onSetAdmin,
}: {
  adminMode: boolean;
  setAdminMode: (v: boolean) => void;
  disabled: boolean;
  poolGen: string;
  busyEpoch: boolean;
  busyAdmin: boolean;
  onAdvance: () => void;
  onSetAdmin: (a: string) => void;
}) {
  const [newAdmin, setNewAdmin] = useState("");
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="head">
        <span className="t">Admin / keeper</span>
        <label style={{ fontSize: 10, color: "#cfcfcf", display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={adminMode} onChange={(e) => setAdminMode(e.target.checked)} style={{ width: "auto" }} />
          I HOLD ADMIN KEY
        </label>
      </div>
      <div className="body">
        <div className="notice" style={{ display: "flex", justifyContent: "space-between", marginTop: 0 }}>
          <span>Bond pool balance</span>
          <strong>{poolGen} GEN</strong>
        </div>
        {adminMode ? (
          <>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn" disabled={disabled || busyEpoch} onClick={onAdvance}>
                {busyEpoch ? <span className="spin" /> : null} Advance epoch
              </button>
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label>Rotate admin → address</label>
              <input type="text" value={newAdmin} onChange={(e) => setNewAdmin(e.target.value)} placeholder="0x…" />
              <button
                className="btn danger"
                style={{ marginTop: 6 }}
                disabled={disabled || busyAdmin || !/^0x[0-9a-fA-F]{40}$/.test(newAdmin.trim())}
                onClick={() => onSetAdmin(newAdmin)}
              >
                {busyAdmin ? <span className="spin" /> : null} Set admin
              </button>
            </div>
            <div className="notice">Admin-only transactions revert for non-admin keys.</div>
          </>
        ) : (
          <div className="notice" style={{ marginTop: 10 }}>
            Enable “I hold admin key” to reveal epoch / admin controls. <Lightning size={12} weight="fill" style={{ verticalAlign: "-1px" }} />
          </div>
        )}
      </div>
    </div>
  );
}
