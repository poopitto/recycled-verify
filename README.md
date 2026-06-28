# Recur

Recycled-content audit on [GenLayer](https://genlayer.com). Every lot is a node in a supply-chain DAG; before any model runs, the contract checks that a lot's claimed recycled mass never exceeds the verified mass of its parents, then a two-tier LLM scores the claim under validator consensus and writes an eco-label on-chain.

## How it works

1. Register a lot: submit its material, region, mass, claimed recycled mass, and parent lot ids. The required GEN bond scales with how many lots already crowd the same (material, region) cell.
2. Submit the trace: the claimant attaches the chain-of-custody evidence for the lot.
3. Mass balance: a deterministic pass walks one step up the DAG and rejects any lot whose claimed recycled mass exceeds its parents' verified capacity.
4. Adjudicate: a T1 LLM reads the trace plus each parent's verified history and scores recycled content 0–100; lots at or above 5 tonnes escalate to a T2 deep audit.
5. Settle: a verified lot earns the eco-label and a bond refund, a greenwash ruling slashes the bond, and if an ancestor is later overturned every descendant is flagged for re-audit.

## Architecture

```
backend/recycled-verify.py   GenLayer Intelligent Contract (Python, runs on the GenVM)
frontend/                    React + Vite + TypeScript dashboard (genlayer-js)
```

A claim is never judged in isolation: the deterministic mass-balance gate runs before the LLM, so validator consensus is spent only on lots that are already arithmetically possible.

## Live deployment

- **Network**: GenLayer Studionet (chain id 61999)
- **Contract**: `0x9C7CB09DFf6e3CC999360d17a65B9A83FD6E0145`
- **App**: https://poopitto.github.io/recycled-verify/

## Run locally

```bash
cd frontend
npm install
npm run dev
npm run build
```

The committed `.env` holds the public Studionet config; no secrets are required. Copy `.env.example` to `.env.local` only to override.

## Environment variables

| Name | Required | Description |
|------|----------|-------------|
| `VITE_CONTRACT_ADDRESS` | yes | Deployed RecycledVerify contract on Studionet |
| `VITE_CHAIN_ID` | yes | GenLayer chain id (61999) |
| `VITE_RPC_URL` | yes | Studionet JSON-RPC endpoint |

## Deploy the contract

```bash
npx genlayer deploy --contract backend/recycled-verify.py
```

## Contract methods (`RecycledVerify`)

| Method | Type | Description |
|--------|------|-------------|
| `register_lot` | payable | Register a lot in the DAG; bond scales with (material, region) density. |
| `submit_trace` | write | Attach the chain-of-custody trace to a registered lot. |
| `verify_mass_balance` | write | Deterministic check that recycled mass never exceeds parent capacity. |
| `adjudicate` | write | T1 LLM audit reading the trace plus each parent's verified history. |
| `adjudicate_deep` | write | T2 deep audit; mandatory for lots at or above 5 tonnes. |
| `issue_label` | write | Settle the lot: issue or deny the eco-label, refund or slash the bond. |
| `cascade_flag_descendants` | write | Flag every descendant for re-audit when an ancestor is overturned. |
| `advance_epoch` | write | Admin advances the epoch clock. |
| `set_admin` | write | Rotate the admin/keeper address. |
| `get_lot` | view | Full lot dossier with DAG edges, ruling, and percentages. |
| `get_lots_by_material` | view | Lot ids registered under a material tag. |
| `get_lots_by_region` | view | Lot ids registered in a region. |
| `get_material_region_density` | view | Registration density for a (material, region) cell. |
| `get_ancestors` | view | All ancestor lot ids for a lot. |
| `get_descendants` | view | All descendant lot ids for a lot. |
| `list_lots` | view | All lot ids. |
| `get_pool_balance` | view | Pooled bond balance in wei. |
| `get_counts` | view | Compact counter string for the dashboard. |

## License

MIT
