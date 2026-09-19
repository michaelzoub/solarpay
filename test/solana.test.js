import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { DEVNET_FAUCET_URL, DevnetSolana } from "../server/solana.js";

test("devnet airdrop confirms and waits until the funded balance is visible", async () => {
  const solana = new DevnetSolana("https://api.devnet.solana.com");
  const balances = [0, 0, 100_000_000];
  solana.connection = {
    async getBalance() { return balances.shift() ?? 100_000_000; },
    async requestAirdrop() { return "airdrop-signature"; },
    async confirmTransaction() { return { value: { err: null } }; },
  };

  const result = await solana.airdrop(Keypair.generate().publicKey.toBase58(), 100_000_000);

  assert.equal(result.signature, "airdrop-signature");
  assert.equal(result.balanceLamports, 100_000_000);
});

test("devnet airdrop failures include a public faucet recovery path", async () => {
  const recipientAddress = Keypair.generate().publicKey.toBase58();
  const solana = new DevnetSolana("https://api.devnet.solana.com");
  solana.connection = {
    async getBalance() { return 0; },
    async requestAirdrop() { throw new Error("rate limited"); },
  };

  await assert.rejects(
    solana.airdrop(recipientAddress, 100_000_000),
    (error) => error.code === "SOLANA_FAUCET_UNAVAILABLE"
      && error.status === 503
      && error.faucetUrl === DEVNET_FAUCET_URL
      && error.recipientAddress === recipientAddress,
  );
});
