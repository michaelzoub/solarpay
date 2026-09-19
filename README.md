# SolarPay

SolarPay is a badge-to-badge payment prototype powered by Solana devnet.

A merchant laptop coordinates payments, badges provide the nearby checkout experience, and a shared backend manages wallets, payment intents, and transaction signing.

## Components

- **Laptop application** — coordinates badge setup and payments
- **Terminal badge** — displays and broadcasts payment requests
- **Customer badge** — displays and approves payments
- **Backend** — manages wallets, intents, validation, and signing
- **Database** — stores badge and payment data

## Customer Setup

1. Connect the customer badge to a laptop.
2. The laptop reads its badge ID.
3. The backend creates a Solana wallet.
4. The database stores:

   ```text
   badge ID → Solana address → encrypted private key reference
   ```

5. The address receives devnet SOL.
6. The badge is ready to approve payments.

Badges never store private keys, balances, wallets, or transaction history.

## Merchant Checkout

1. Connect the terminal badge to the merchant laptop.
2. The laptop reads the terminal badge ID and fetches the merchant address.
3. The merchant enters an amount in SOL.
4. The laptop creates a payment intent through the backend.
5. The laptop sends the intent to the terminal badge over USB.
6. The terminal badge displays and broadcasts it over badge radio.
7. The customer badge displays the payment.
8. The customer presses **A** to approve.
9. The customer badge sends its badge ID and intent nonce to the terminal badge.
10. The terminal badge relays the approval to the laptop.
11. The laptop asks the backend to resolve both wallet addresses and validate the payment.
12. The backend signs the transaction without exposing the private key.
13. The laptop submits it to Solana devnet.
14. The laptop and terminal badge display the result.

## Payment Intents

Each intent contains:

- Merchant address
- Amount in lamports
- Unique nonce
- Expiration time
- Protocol version

Expired, reused, invalid, or already-paid intents must be rejected.

## Badge Applications

The terminal badge Lua app:

- Communicates with the laptop over USB
- Displays the amount and countdown
- Broadcasts payment intents
- Relays customer approvals
- Shows the payment result

The customer badge Lua app:

- Receives payment intents
- Displays the merchant and amount
- Requires button **A** for approval
- Sends its badge ID and the intent nonce

## Development

Local development should support simulated badges, serial communication, radio messages, and Solana transactions when physical hardware is unavailable.

```makefile
DATABASE_URL=
SOLANA_RPC_URL=https://api.devnet.solana.com
WALLET_ENCRYPTION_KEY=
BACKEND_AUTH_SECRET=
```

## Security

- Private keys never leave the backend.
- Laptops must authenticate with the backend.
- Amounts use integer lamports internally.
- Nonces are unique and can only be consumed once.
- Sensitive values must never be logged.
- Production signing should use a KMS or HSM.

## Status

SolarPay is an experimental Solana devnet prototype. Do not use it with real funds.
