# SolarPay

Tap two Hacker Badges together, one pays the other in SOL.

SolarPay turns the 2026 Hacker Badge into a tap-to-pay terminal. A merchant
badge broadcasts a checkout, a payer's badge hears it, a knock links the two
over radio, and a single button press approves the payment. A backend
settles the transfer on Solana Devnet and a web dashboard ties badges to
wallets.

## How it's put together

| Piece | What it does |
|---|---|
| **Website** ([`web/`](web), served from [`index.html`](index.html)) | React + Vite dashboard. Connects to a badge over USB (Web Serial), registers it, creates checkouts, and shows live payment status. |
| **Backend** ([`server/`](server)) | Node/Express API. Holds encrypted badge wallets in SQLite, submits transfers to Solana Devnet, and optionally syncs badge-to-wallet mappings to Supabase. |
| **Badge firmware** ([`firmware/`](firmware)) | Native C (ESP-IDF) firmware flashed onto the badge's ESP32-C3. Replaces the stock launcher entirely — the badge boots straight into SolarPay, detects a knock between two badges, links them over ESP-NOW, and drives the on-screen approval flow. See [`firmware/README.md`](firmware/README.md) for how tapping and authentication work. |

Everything talks over one USB serial connection between a badge and the
website/backend, plus a badge-to-badge radio link for the actual tap.

## Setup

### Prerequisites

- Node.js 20+
- Chrome or Edge (needed for [Web Serial](https://developer.chrome.com/docs/capabilities/serial), used to talk to a badge over USB)
- A USB **data** cable (not charge-only) if you're connecting a physical badge

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Then edit `.env`:

- `WALLET_ENCRYPTION_KEY` — generate one with `openssl rand -base64 32`. Badge
  wallets can't be registered without it.
- `SOLANA_MODE` — `mock` (no network calls, fake balances) or `devnet` (real
  Solana Devnet transactions, airdrop-funded). `devnet` is the default and
  what the demo uses.
- Leave `SUPABASE_*` blank unless you want badge-to-wallet mappings synced to
  a Supabase table.

### 3. Run it

```bash
npm run dev
```

This starts the backend and the website together. Open
[http://localhost:5173](http://localhost:5173).

### 4. Verify

```bash
npm run check   # runs the test suite, then builds the site
```

## Connecting a badge

A badge needs SolarPay's firmware before the website can do anything useful
with it.

1. **Flash the firmware.** Follow [`firmware/README.md`](firmware/README.md)
   to build with ESP-IDF and flash it over USB. Do this once per badge (two
   badges if you want to test an actual tap).
2. **Connect over the website.** With the dev server running, plug the badge
   in, close any other program using its serial port (the official Badge IDE,
   `screen`, etc. — only one thing can own the port at a time), then use the
   website's connect flow to pair it with a wallet.
3. **Tap to pay.** Create a checkout on the merchant badge/website, then knock
   the two badges together and press **A** on the paying badge to approve.
   Details of the knock-detection and authentication protocol are in
   [`firmware/README.md`](firmware/README.md).

If a badge won't take a flash or comes up blank, see
[`docs/RECOVERY.md`](docs/RECOVERY.md).

## Testing

```bash
npm test              # unit tests (server, protocol, Solana client, Supabase)
npm run test:lua      # link-layer simulation tests (needs `brew install lua`)
npm run badge:e2e      # drives two physical badges through a full tap-to-pay flow
```

The end-to-end harness in [`tools/e2e/`](tools/e2e) talks to real badges over
serial and exercises the actual knock-pairing and approval flow rather than
mocking it — see [`tools/e2e/README.md`](tools/e2e/README.md).

## More docs

- [`firmware/README.md`](firmware/README.md) — badge firmware: build/flash, the tap-detection and pairing protocol, serial contract with the backend
- [`docs/BADGE_ARCHITECTURE.md`](docs/BADGE_ARCHITECTURE.md) — background research on badge hardware and the radio link
- [`docs/RECOVERY.md`](docs/RECOVERY.md) — recovering a badge that won't boot or flash
- [`artifacts/DEMO.md`](artifacts/DEMO.md) — demo script and security model summary
