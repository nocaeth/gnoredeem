# redeem.gno.now — GIP-151 deposit app

Minimal, transparent web app for the GnosisDAO GIP-151 one-time pro-rata treasury
redemption. Holders deposit **GNO** or **osGNO** during the deposit window; everything
is read directly from **Gnosis Chain** (no backend). Styled to match the gno.now dashboard.

## Stack
Vite + React 19 + TypeScript · Bun · Tailwind CSS v4 · wagmi v2 + viem · RainbowKit (dark) ·
@tanstack/react-query · sonner.

## Run
```bash
bun install
bun run dev      # http://localhost:5173
bun run build    # tsc + vite build → dist/
```

## Env (`.env.example` → `.env`)
- `VITE_GNOSIS_RPC` — Gnosis read RPC (defaults to `https://rpc.gnosischain.com`).
- `VITE_WALLETCONNECT_PROJECT_ID` — WalletConnect Cloud id. Injected wallets (MetaMask/Rabby)
  work without it; the mobile/QR option only appears once it's set.

## TODO before launch (all in `src/config.ts` unless noted)
1. **Deploy `RedemptionDeposit`** (see `../contracts`) on Gnosis Chain — constructor takes
   `(gno, osgno, safe, deadline, osgnoRate)`, where `osgnoRate` is `getRate()` read from the
   Stakewise rate provider at the GIP-151 snapshot block (1e18-scaled). Then set
   `REDEMPTION_DEPOSIT_ADDRESS`. Until it's set, the UI shows "Deposits are not open yet."
   Once live, the UI reads the contract's fixed `osgnoRate` for all GNO-equivalent figures.
2. Set `REDEMPTION_SAFE_ADDRESS` (the Safe that receives deposits) — used for the transparency link.
3. Set `REDEMPTION_CLAIM_DATE` (when claiming opens) once the vote timing is known. The deposit
   window close is read on-chain from the contract's `deadline`.
4. Set `VITE_WALLETCONNECT_PROJECT_ID`.

## Verified on-chain (Gnosis Chain, chainId 100)
- GNO `0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb` (18 dec)
- osGNO `0xF490c80aAE5f2616d3e3BDa2483E30C4CB21d1A0` (18 dec)
- Stakewise rate provider `0x9B1b13afA6a57e54C03AD0428a4766C39707D272` — `getRate()` (1e18-scaled osGNO→GNO)

This app covers the **deposit** phase only. Claiming (the Merkle distribution) is a later phase.
