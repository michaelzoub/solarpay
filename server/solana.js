import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createHash } from "node:crypto";

export const DEVNET_FAUCET_URL = "https://faucet.solana.com/";

export class DevnetSolana {
  constructor(rpcUrl) { this.connection = new Connection(rpcUrl, { commitment: "confirmed", confirmTransactionInitialTimeout: 60_000 }); }

  generateWallet() {
    const wallet = Keypair.generate();
    return { publicKey: wallet.publicKey.toBase58(), secretKey: Buffer.from(wallet.secretKey).toString("base64") };
  }

  async getBalance(address) { return this.connection.getBalance(new PublicKey(address), "confirmed"); }

  async airdrop(address, lamports) {
    const publicKey = new PublicKey(address);
    const balanceBefore = await this.connection.getBalance(publicKey, "confirmed");
    let signature;
    try {
      signature = await this.connection.requestAirdrop(publicKey, lamports);
    } catch (cause) {
      throw faucetUnavailableError(address, cause);
    }
    // The faucet owns the airdrop transaction, so a blockhash fetched by this
    // client is not a valid confirmation strategy for it. Confirm by signature.
    try {
      const confirmation = await this.connection.confirmTransaction(signature, "confirmed");
      assertConfirmed(confirmation, "Airdrop");
    } catch (cause) {
      throw faucetUnavailableError(address, cause);
    }
    let balanceAfter;
    try {
      balanceAfter = await waitForBalance(this.connection, publicKey, balanceBefore + lamports);
    } catch (cause) {
      throw faucetUnavailableError(address, cause);
    }
    if (balanceAfter < balanceBefore + lamports) throw faucetUnavailableError(address, new Error("Airdrop confirmed but the funded balance is not visible yet"));
    return { signature, lamports, balanceLamports: balanceAfter };
  }

  async signTransfer({ fromWallet, toAddress, amountLamports, intentId }) {
    const payer = Keypair.fromSecretKey(Buffer.from(fromWallet.secretKey, "base64"));
    if (payer.publicKey.toBase58() !== fromWallet.publicKey) throw new Error("Encrypted wallet key does not match its address");
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight })
      .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(toAddress), lamports: amountLamports }));
    transaction.sign(payer);
    return {
      rawTransaction: transaction.serialize().toString("base64"),
      signature: transaction.signature.toString("base64"),
      blockhash,
      lastValidBlockHeight,
      intentId,
    };
  }

  async submitAndConfirm(signed) {
    const signature = await this.connection.sendRawTransaction(Buffer.from(signed.rawTransaction, "base64"), {
      skipPreflight: false, maxRetries: 3,
    });
    const confirmation = await this.connection.confirmTransaction({ signature, blockhash: signed.blockhash, lastValidBlockHeight: signed.lastValidBlockHeight }, "confirmed");
    assertConfirmed(confirmation, "Transfer");
    return signature;
  }
}

function assertConfirmed(confirmation, label) {
  if (confirmation?.value?.err) {
    const error = Object.assign(new Error(`${label} failed on Solana: ${JSON.stringify(confirmation.value.err)}`), {
      code: "SOLANA_TRANSACTION_FAILED",
      status: 502,
    });
    throw error;
  }
}

function faucetUnavailableError(recipientAddress, cause) {
  return Object.assign(new Error("The automated Solana airdrop could not fund this sender. Use the public faucet, then refresh the badge balance."), {
    code: "SOLANA_FAUCET_UNAVAILABLE",
    status: 503,
    faucetUrl: DEVNET_FAUCET_URL,
    recipientAddress,
    cause,
  });
}

async function waitForBalance(connection, publicKey, expectedLamports) {
  let balance = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    balance = await connection.getBalance(publicKey, "confirmed");
    if (balance >= expectedLamports) return balance;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return balance;
}

export class MockSolana {
  constructor() { this.balances = new Map(); }
  generateWallet() {
    const wallet = Keypair.generate();
    return { publicKey: wallet.publicKey.toBase58(), secretKey: Buffer.from(wallet.secretKey).toString("base64") };
  }
  fund(address, lamports) { this.balances.set(address, lamports); }
  async airdrop(address, lamports) {
    this.balances.set(address, (this.balances.get(address) || 0) + lamports);
    return { signature: `mock-airdrop-${address.slice(0, 12)}`, lamports, balanceLamports: this.balances.get(address) };
  }
  async getBalance(address) { return this.balances.get(address) || 0; }
  async signTransfer({ fromWallet, toAddress, amountLamports, intentId }) {
    const available = this.balances.get(fromWallet.publicKey) ?? 10_000_000_000;
    if (available < amountLamports) throw Object.assign(new Error("Customer wallet has insufficient funds"), { code: "INSUFFICIENT_FUNDS", status: 422 });
    const payload = Buffer.from(JSON.stringify({ from: fromWallet.publicKey, to: toAddress, amountLamports, intentId })).toString("base64");
    return { rawTransaction: payload, signature: createHash("sha256").update(payload).digest("base64"), blockhash: "mock", lastValidBlockHeight: 1 };
  }
  async submitAndConfirm(signed) {
    const transfer = JSON.parse(Buffer.from(signed.rawTransaction, "base64").toString("utf8"));
    const available = this.balances.get(transfer.from) ?? 10_000_000_000;
    if (available < transfer.amountLamports) throw new Error("Insufficient mock balance at submission");
    this.balances.set(transfer.from, available - transfer.amountLamports);
    this.balances.set(transfer.to, (this.balances.get(transfer.to) || 0) + transfer.amountLamports);
    return `mock-${createHash("sha256").update(signed.rawTransaction).digest("hex").slice(0, 32)}`;
  }
}
