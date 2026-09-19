import { randomUUID } from "node:crypto";

export type Intent = {
  nonce: string;
  merchantBadgeId: string;
  merchantAddress: string;
  customerAddress?: string;
  amountLamports: number;
  expiresAt: string;
  protocolVersion: 1;
  status: "pending" | "paid";
};

const wallets = new Map([
  ["terminal-01", { address: "Merch3r1111111111111111111111111111111111111", balance: 2_000_000_000 }],
  ["customer-01", { address: "Cust0mer111111111111111111111111111111111111", balance: 1_000_000_000 }],
]);
const intents = new Map<string, Intent>();

export function createIntent(merchantBadgeId: string, amountLamports: number) {
  const wallet = wallets.get(merchantBadgeId);
  if (!wallet) throw new Error("Unknown merchant badge");
  if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0) throw new Error("Amount must be positive whole lamports");
  const intent: Intent = { nonce: randomUUID(), merchantBadgeId, merchantAddress: wallet.address, amountLamports, expiresAt: new Date(Date.now() + 120_000).toISOString(), protocolVersion: 1, status: "pending" };
  intents.set(intent.nonce, intent);
  return intent;
}

export function resolveIntent(nonce: string, customerBadgeId: string) {
  const intent = intents.get(nonce);
  const customer = wallets.get(customerBadgeId);
  if (!intent || !customer) throw new Error("Invalid payment request");
  if (intent.status !== "pending") throw new Error("Payment request has already been used");
  if (Date.parse(intent.expiresAt) < Date.now()) throw new Error("Payment request expired");
  if (customer.balance < intent.amountLamports) throw new Error("Customer balance is too low");
  const merchant = wallets.get(intent.merchantBadgeId)!;
  customer.balance -= intent.amountLamports;
  merchant.balance += intent.amountLamports;
  intent.customerAddress = customer.address;
  intent.status = "paid";
  return { signature: `sim-${randomUUID()}`, merchantBalance: merchant.balance, customerBalance: customer.balance };
}