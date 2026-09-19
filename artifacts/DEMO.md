# SolarPay demo

SolarPay is a Solana devnet prototype for nearby badge payments. A merchant laptop creates a short-lived payment request, a payer approves it from a Hacker Badge, and the backend signs without exposing private keys.

## What to show

1. Open the SolarPay website.
2. Close the official Badge IDE and other serial monitors; only one browser page can own the badge port.
3. Choose **Sender** or **Merchant**, connect the badge normally without holding START, and let SolarPay create the profile and install the matching role-specific app.
4. Wait for the automatic reboot, then open SolarPay from the badge launcher.
5. Repeat setup on the other badge. Keep the merchant connected to the website and keep SolarPay open on both badges.
6. Create a merchant checkout and approve it with **A** on the sender badge or by physically tapping it while the merchant is nearby.
7. Show the confirmed mock or devnet transaction and the confirmation state on the merchant badge.

## Run locally

```sh
npm install
npm run dev
```

Open `http://localhost:5173`.

Run verification with:

```sh
npm run check
```

## Share diagnostics

Use the download button in the website header to export a sanitized diagnostics JSON file. It includes runtime mode, database migration versions, profile counts, payment-state counts, server uptime, and browser context. It excludes private keys, authentication secrets, payment nonces, and wallet mappings.

For a physical badge failure, export SolarPay diagnostics and capture the first badge console error. Note whether it failed during console detection, upload, app launch, intent display, approval, or settlement. Do not share environment files, private keys, or complete database files.

## Security model

- Badges receive only a profile identifier and public Solana address.
- Private keys remain encrypted on the backend.
- Payment amounts use integer lamports.
- Intents expire and use one-time nonces.
- Submitted transaction bytes must match the transaction signed by the backend.

## Hardware boundary

SolarPay uses the same serial console protocol and upload pacing as the official Custom Apps IDE: bare-CR commands, 128-byte chunks, 20 ms pauses, launcher reload, and a reboot after changing runtime manifest settings. A physical badge must still be selected in the browser's Web Serial prompt, and no other page or process can own the port.

If setup says the console is not ready, leave USB connected, turn the badge off and on normally without holding START, wait for the launcher, close the official IDE/serial monitors, and retry. SolarPay tests the console before creating a wallet, and a retry after a partial upload reuses the same in-progress profile.
