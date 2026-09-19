# SolarPay sender/merchant E2E research

Research date: 2026-09-19

## Outcome

The flow needs three independent channels to work in sequence:

1. Web Serial installs and controls the personalized merchant app.
2. Badge radio carries a short-lived intent to the sender and returns approval.
3. The backend signs/submits the transaction, then Web Serial writes the result back to the merchant badge.

The original failure happened before channel 1 was established. Opening a serial port only proves that the browser owns a USB endpoint; it does not prove that the badge command console is at a live `badge> ` prompt.

## Authoritative uploader behavior

The official [Hacker Badge Custom Apps IDE](https://badge.hackthenorth.com/ide/) uses:

- 115200 baud with a 4096-byte browser buffer;
- bare carriage returns for console commands;
- an empty command followed by a `badge> ` prompt check before upload;
- 128-byte writes with 20 ms pauses because the badge RX ring is 256 bytes;
- `put <path> <length>`, followed by `READY`, raw bytes, and `OK <length>`;
- `reload` after upload so the launcher rescans installed apps;
- explicit Ctrl-C and reboot controls for recovery.

SolarPay follows those transport rules with additional safety margin: 64-byte writes with 30 ms pauses, a bounded blank-command/Ctrl-C recovery sequence, and one automatic retry after a recoverable missing file acknowledgement. If the console still does not respond, setup stops before creating a new wallet and gives power-cycle instructions.

## Fixed failure modes

### Console unavailable

Setup now proves that `badge> ` is reachable before wallet creation. This prevents a USB connection that only streams logs from being mistaken for an upload-ready console.

### Duplicate profiles on retry

The previous order was connect → create/fund wallet → discover that upload could not start. Retrying could create another profile. Setup now validates the console first and retains an in-progress profile across upload retries.

### Partial upload wedges `put`

Firmware waits for the declared byte count and has no receive timeout. If a transfer fails, SolarPay sends the remaining upper-bound padding, reacquires the prompt, and reports whether retry is safe. The next complete upload overwrites the interrupted file.

Before a full app install, SolarPay also injects HOME and reacquires the prompt. This exits an older running copy so radio/NFC work and application logging do not compete with the larger `main.lua` transfer. A missing `OK <length>` is retried once automatically after console recovery.

### New heap setting not active

Launcher reload updates discovery metadata but does not guarantee runtime manifest changes such as `heap_kb=48` are active for an existing slug. Installation now reboots after reload.

### Merchant forgets approval before settlement

The merchant previously cleared its active intent 3.5 seconds after radio approval. A slower network confirmation then could not match the intent. It now retains the intent through its original deadline and accepts either `SP1:C:<id>` or `SP1:E:<id>` from the laptop.

### Wrong Solana cluster

The local runtime was configured for testnet even though SolarPay's faucet flow is a devnet prototype. It now uses devnet. Existing public/private keypairs remain valid, but balances are cluster-specific; senders must receive devnet funds.

## Working physical flow

### Sender setup

1. Close the official Badge IDE and all serial monitors.
2. Turn the sender badge off, connect a data-capable USB cable, and turn it on normally without holding START.
3. In SolarPay, choose Sender setup and select the USB JTAG/serial debug unit.
4. SolarPay verifies the console, creates and funds the sender wallet, uploads the customer-only app and QR asset, reloads, and reboots.
5. Wait for the launcher and open SolarPay. The sender can then be disconnected from USB.

### Merchant setup

1. Repeat the clean USB connection procedure with the merchant badge.
2. Choose Merchant setup. SolarPay installs the merchant-only app without the QR asset, reloads, and reboots.
3. Wait for the launcher, open SolarPay, and keep this badge connected to the laptop.

### Checkout

1. Keep SolarPay open on both badges and keep them nearby.
2. Select the registered merchant, enter a positive SOL amount, and start checkout.
3. The laptop writes `intent.txt` and injects START on the merchant badge.
4. The merchant broadcasts the 44-byte-bounded intent. The sender displays it.
5. Press A on the sender or physically tap while it has a recent merchant beacon.
6. The merchant logs `approval_received`; the website verifies the badge mapping and nonce, signs, submits, and confirms the transaction.
7. The website writes the confirmation receipt to the merchant, which displays the final state.

## Verification performed

- Full API/radio/payment simulation: profile creation, funding, intent broadcast, sender display, approval, backend signing, submission, merchant settlement, and balance changes.
- Serial simulation: prompt recovery via Ctrl-C, role-specific upload, file acknowledgements, launcher reload, and reboot.
- Production web build.
- Local browser render of both Sender setup and Merchant setup paths.

No USB badge device was attached during the final run, so the remaining acceptance test is a two-badge physical pass using the steps above.
