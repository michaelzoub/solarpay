// The end-to-end scenarios, written against tools/e2e/rig.js.
//
// Every scenario returns both badges to a known state at the end, so the suite
// can be run in a loop without one test's leftovers explaining the next test's
// result. Anything a scenario asserts comes from SP_TEST_STATE or an SP_EVT,
// never from a sleep-and-hope.
import { knock, sleep } from "./rig.js";

const SOL = 1_000_000_000;
let seq = 0;
const intentId = () => (Date.now().toString(16) + (seq++).toString(16)).padStart(16, "0").slice(-16);
const nonceFor = (id) => `n${id.slice(-8)}`;

export function checkout({ lamports = 0.25 * SOL, ttl = 90, item = "FLAT_WHITE" } = {}) {
  const id = intentId();
  const nonce = nonceFor(id);
  return {
    id, nonce, lamports, item, ttl,
    intentLine: `SP_INTENT SP1:I:${id}:${lamports}:${ttl}:${nonce}:tag${id.slice(-4)}`,
    itemLine: `SP_ITEM SP1:M:${id}:${item}`,
  };
}

// Put both badges in a known place: home screen, no checkout, nothing armed.
export async function reset(sender, merchant) {
  for (const b of [sender, merchant]) {
    b.btn("HOME");
    await sleep(120);
  }
  await sleep(250);
  for (const b of [sender, merchant]) {
    const s = await b.state();
    if (s.mode !== "home") throw new Error(`${b.name}: could not return to home, mode=${s.mode}`);
  }
}

// Home -> the named mode, via the same two presses a thumb would make.
export async function enterMode(badge, mode) {
  badge.btn(mode === "sender" ? "LEFT" : "RIGHT");
  await sleep(120);
  badge.btn("A");
  await sleep(200);
  const s = await badge.state();
  if (s.mode !== mode) throw new Error(`${badge.name}: expected mode ${mode}, got ${s.mode}`);
  return s;
}

// The whole happy path, as one reusable block: both badges in mode, a checkout
// pushed to the merchant, a knock, the charge crossing the link, A, and the
// approval line the laptop settles on.
export async function payOnce(sender, merchant, opts = {}) {
  const co = checkout(opts);
  const t0 = Date.now();

  await enterMode(sender, "sender");
  await enterMode(merchant, "merchant");

  // The sender must initiate before it is pairable at all.
  sender.btn("A");
  await sender.until((s) => s.armed, { what: "sender armed", timeout: 3000 });

  const loaded = merchant.waitFor("intent_loaded");
  merchant.send(co.intentLine);
  merchant.send(co.itemLine);
  await loaded;

  const bothPaired = Promise.all([
    sender.until((s) => s.link === "paired", { what: "sender paired", timeout: 4000 }),
    merchant.until((s) => s.link === "paired", { what: "merchant paired", timeout: 4000 }),
  ]);
  await knock(sender, merchant);
  await bothPaired;

  // Details cross only after the link is authenticated.
  const charged = await sender.until((s) => s.intent === co.id, { what: "charge received", timeout: 4000 });
  if (charged.lamports !== co.lamports) {
    throw new Error(`sender got ${charged.lamports} lamports, expected ${co.lamports}`);
  }
  if (charged.item !== co.item.replace(/_/g, " ")) {
    throw new Error(`sender got item "${charged.item}", expected "${co.item.replace(/_/g, " ")}"`);
  }
  if (charged.nonce !== co.nonce) {
    throw new Error(`sender got nonce "${charged.nonce}", expected "${co.nonce}"`);
  }

  const approval = merchant.waitForApproval({ timeout: 6000 });
  sender.btn("A");
  const got = await approval;
  const expected = `SP1:A:${co.id}:${sender.identity?.id ?? ""}:${co.nonce}`;
  if (!got.payload.startsWith(`SP1:A:${co.id}:`)) {
    throw new Error(`approval was "${got.payload}", expected to start SP1:A:${co.id}:`);
  }
  if (!got.payload.endsWith(`:${co.nonce}`)) {
    throw new Error(`approval "${got.payload}" did not carry nonce ${co.nonce}`);
  }

  // Settle it, as the laptop would. The merchant now holds the link open across
  // settlement, so the verdict reaches the sender over the radio rather than
  // dying on the merchant badge.
  const signature = opts.signature ?? `5xTestSig${co.id.slice(-6)}`;
  const confirmLine = opts.payerLamports === undefined
    ? `SP_CONFIRM ${co.id} ${signature}`
    : `SP_CONFIRM ${co.id} ${signature} ${opts.payerLamports}`;

  const confirmed = merchant.waitFor("settlement_confirmed");
  const relayed = sender.waitFor("settlement_confirmed", { timeout: 8000 });
  merchant.send(confirmLine);
  await confirmed;
  const settled = await relayed;

  return { checkout: co, ms: Date.now() - t0, approval: got.payload, expected, signature, settled };
}

export const scenarios = [
  {
    name: "happy path: knock, charge, approve, confirm",
    async run(sender, merchant) {
      const r = await payOnce(sender, merchant);
      const m = await merchant.state();
      if (m.intent !== "none") throw new Error(`merchant kept intent ${m.intent} after confirm`);
      if (m.result !== "CONFIRMED") throw new Error(`merchant result was ${m.result}, expected CONFIRMED`);
      return `paid ${r.checkout.lamports} lamports in ${r.ms}ms`;
    },
  },

  {
    name: "settlement reaches the sender: balance deducted, hash shown",
    async run(sender, merchant) {
      await enterMode(sender, "sender");

      // A provisioned wallet is what the deduction lands in; without one the
      // badge has no balance to move.
      const address = "SoLarPayTestWa11et1111111111111111111111111";
      const before = 1 * SOL;
      const after  = before - 0.25 * SOL - 5000;   // the amount, plus a plausible fee
      sender.send(`SP_WALLET ${address} ${before}`);
      await sender.until((s) => s.wallet && s.balance === before,
        { what: "sender wallet provisioned", timeout: 4000 });

      const r = await payOnce(sender, merchant, { payerLamports: after });

      const s = await sender.state();
      if (s.result !== "CONFIRMED") {
        throw new Error(`sender result was ${s.result}, expected CONFIRMED`);
      }
      if (s.balance !== after) {
        throw new Error(`sender balance was ${s.balance}, expected ${after}`);
      }
      if (s.signature !== r.signature) {
        throw new Error(`sender signature was "${s.signature}", expected "${r.signature}"`);
      }
      // The link is held open only for settlement; it must not stay up.
      await merchant.until((m) => !m.awaiting, { what: "merchant released the link", timeout: 4000 });
      return `deducted ${before - after} lamports, hash ${s.signature}`;
    },
  },

  {
    name: "a failed settlement leaves the sender balance alone",
    async run(sender, merchant) {
      await enterMode(sender, "sender");
      const address = "SoLarPayTestWa11et1111111111111111111111111";
      const before = 1 * SOL;
      sender.send(`SP_WALLET ${address} ${before}`);
      await sender.until((s) => s.wallet && s.balance === before,
        { what: "sender wallet provisioned", timeout: 4000 });

      // Everything up to the approval, then a failure instead of a confirm.
      const co = checkout();
      await enterMode(merchant, "merchant");
      sender.btn("A");
      await sender.until((s) => s.armed, { what: "sender armed", timeout: 3000 });
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      merchant.send(co.itemLine);
      await loaded;
      const bothPaired = Promise.all([
        sender.until((s) => s.link === "paired", { what: "sender paired", timeout: 4000 }),
        merchant.until((s) => s.link === "paired", { what: "merchant paired", timeout: 4000 }),
      ]);
      await knock(sender, merchant);
      await bothPaired;
      await sender.until((s) => s.intent === co.id, { what: "charge received", timeout: 4000 });

      const approval = merchant.waitForApproval({ timeout: 6000 });
      sender.btn("A");
      await approval;

      const failedOnSender = sender.waitFor("settlement_failed", { timeout: 8000 });
      merchant.send(`SP_FAIL ${co.id}`);
      await failedOnSender;

      const s = await sender.state();
      if (s.result !== "FAILED") {
        throw new Error(`sender result was ${s.result}, expected FAILED`);
      }
      if (s.balance !== before) {
        throw new Error(`sender balance moved to ${s.balance} on a failed settlement, expected ${before}`);
      }
      return `balance held at ${before} lamports`;
    },
  },

  {
    name: "sender is not pairable until it initiates",
    async run(sender, merchant) {
      await enterMode(sender, "sender");
      await enterMode(merchant, "merchant");
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      await loaded;

      // Sender never pressed A, so a knock must not pair anything.
      await knock(sender, merchant);
      await sleep(1200);
      const s = await sender.state();
      const m = await merchant.state();
      if (s.link === "paired" || m.link === "paired") {
        throw new Error(`paired without the sender initiating (sender=${s.link} merchant=${m.link})`);
      }
      return "un-armed sender refused the knock";
    },
  },

  {
    name: "merchant with no checkout is not pairable",
    async run(sender, merchant) {
      await enterMode(sender, "sender");
      await enterMode(merchant, "merchant");
      sender.btn("A");
      await sender.until((s) => s.armed, { what: "sender armed" });

      await knock(sender, merchant);
      await sleep(1200);
      const s = await sender.state();
      const m = await merchant.state();
      if (s.link === "paired" || m.link === "paired") {
        throw new Error(`paired with no checkout live (sender=${s.link} merchant=${m.link})`);
      }
      return "merchant with no checkout refused the knock";
    },
  },

  {
    name: "wrong mode: two senders never pair",
    async run(sender, merchant) {
      await enterMode(sender, "sender");
      await enterMode(merchant, "sender");
      sender.btn("A");
      merchant.btn("A");
      await sleep(400);
      await knock(sender, merchant);
      await sleep(1200);
      const s = await sender.state();
      const m = await merchant.state();
      if (s.link === "paired" || m.link === "paired") {
        throw new Error(`two senders paired (a=${s.link} b=${m.link})`);
      }
      return "same-role badges refused each other";
    },
  },

  {
    name: "uncorrelated knocks do not pair",
    async run(sender, merchant) {
      await enterMode(sender, "sender");
      await enterMode(merchant, "merchant");
      sender.btn("A");
      await sender.until((s) => s.armed, { what: "sender armed" });
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      await loaded;

      // Far outside SPLINK_IMPACT_MATCH_MS (150ms).
      sender.impact(1800);
      await sleep(700);
      merchant.impact(1800);
      await sleep(1200);

      const s = await sender.state();
      const m = await merchant.state();
      if (s.link === "paired" || m.link === "paired") {
        throw new Error(`paired on knocks 700ms apart (sender=${s.link} merchant=${m.link})`);
      }
      return "impacts 700ms apart were refused";
    },
  },

  {
    name: "sub-threshold shock does not pair",
    async run(sender, merchant) {
      await enterMode(sender, "sender");
      await enterMode(merchant, "merchant");
      sender.btn("A");
      await sender.until((s) => s.armed, { what: "sender armed" });
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      await loaded;

      // 600 mg is a button press, not a knock (SPLINK_IMPACT_MG is 1200).
      await knock(sender, merchant, { mg: 600, spread: 1.0 });
      await sleep(1200);
      const s = await sender.state();
      if (s.link === "paired") throw new Error("paired on a 600mg button-press shock");
      return "600mg shock ignored";
    },
  },

  {
    name: "mismatched knock strength does not pair",
    async run(sender, merchant) {
      await enterMode(sender, "sender");
      await enterMode(merchant, "merchant");
      sender.btn("A");
      await sender.until((s) => s.armed, { what: "sender armed" });
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      await loaded;

      // The weaker impact must be at least SPLINK_IMPACT_RATIO_PCT (25%) of the
      // stronger. 1250 against 6000 is 20%, so this pair must be refused.
      await knock(sender, merchant, { mg: 6000, spread: 1250 / 6000 });
      await sleep(1200);
      const s = await sender.state();
      const m = await merchant.state();
      if (s.link === "paired" || m.link === "paired") {
        throw new Error(`paired on a 20% strength mismatch (sender=${s.link} merchant=${m.link})`);
      }
      return "20% strength mismatch refused";
    },
  },

  {
    name: "checkout expires on its own",
    async run(sender, merchant) {
      await enterMode(merchant, "merchant");
      const co = checkout({ ttl: 3 });
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      await loaded;
      const expired = await merchant.waitFor("intent_expired", { timeout: 8000 });
      const m = await merchant.state();
      if (m.intent !== "none") throw new Error(`intent ${m.intent} survived expiry`);
      if (m.armed) throw new Error("merchant still armed after expiry");
      return `expired after ttl, intent=${expired.fields.intent}`;
    },
  },

  {
    name: "merchant cancels a live checkout with B",
    async run(sender, merchant) {
      await enterMode(merchant, "merchant");
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      await loaded;
      const cancelled = merchant.waitFor("intent_cancelled");
      merchant.btn("B");
      await cancelled;
      const m = await merchant.state();
      if (m.intent !== "none") throw new Error(`intent ${m.intent} survived cancel`);
      if (m.armed) throw new Error("merchant still armed after cancel");
      return "cancel cleared the checkout and disarmed";
    },
  },

  {
    name: "sender declines with B after the charge arrives",
    async run(sender, merchant) {
      await enterMode(sender, "sender");
      await enterMode(merchant, "merchant");
      sender.btn("A");
      await sender.until((s) => s.armed, { what: "sender armed" });
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      merchant.send(co.itemLine);
      await loaded;
      await knock(sender, merchant);
      await sender.until((s) => s.intent === co.id, { what: "charge received", timeout: 4000 });

      const declined = sender.waitFor("intent_declined", { timeout: 3000 }).catch(() => null);
      sender.btn("B");
      await declined;
      const s = await sender.until((x) => x.intent === "none", { what: "sender cleared", timeout: 4000 });
      if (s.intent !== "none") throw new Error("sender kept the charge after declining");

      // And crucially: no approval ever reached the merchant.
      await sleep(600);
      const m = await merchant.state();
      if (m.approved !== "none") throw new Error(`merchant recorded approval ${m.approved} after a decline`);
      return "decline cleared the sender and sent nothing";
    },
  },

  {
    name: "settlement failure is reported and clears the checkout",
    async run(sender, merchant) {
      await enterMode(merchant, "merchant");
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      await loaded;
      const failed = merchant.waitFor("settlement_failed");
      merchant.send(`SP_FAIL ${co.id}`);
      await failed;
      const m = await merchant.state();
      if (m.result !== "FAILED") throw new Error(`result was ${m.result}, expected FAILED`);
      if (m.intent !== "none") throw new Error("failed settlement left the checkout live");
      return "failure surfaced and cleared";
    },
  },

  {
    name: "malformed and stale console lines are refused",
    async run(sender, merchant) {
      await enterMode(merchant, "merchant");
      const before = await merchant.state();

      const bad = [
        "SP_INTENT not-even-close",
        "SP_INTENT SP1:I:zzzz:nope:90:n1:tag",       // non-hex intent, non-numeric lamports
        "SP_INTENT SP1:I:abc123",                     // truncated
        "SP_INTENT SP1:I:abc123:100:90",              // too few fields
        "SP_ITEM SP1:M:deadbeef:ORPHANED_ITEM",       // item for an intent we never had
        "SP_CONFIRM",                                  // no argument at all
        "SP_NONSENSE hello",
        "",
      ];
      for (const line of bad) { merchant.send(line); await sleep(60); }
      await sleep(400);

      const after = await merchant.state();
      if (after.intent !== "none") throw new Error(`garbage created intent ${after.intent}`);
      if (after.lamports !== 0) throw new Error(`garbage set lamports to ${after.lamports}`);
      if (after.heap < before.heap * 0.75) {
        throw new Error(`heap fell from ${before.heap} to ${after.heap} on malformed input`);
      }
      return "8 malformed lines refused, no state change";
    },
  },

  {
    name: "an overlong console line cannot overrun the parser",
    async run(sender, merchant) {
      await enterMode(merchant, "merchant");
      const before = await merchant.state();
      merchant.send("SP_INTENT SP1:I:" + "a".repeat(4000) + ":100:90:n:t");
      merchant.send("SP_ITEM SP1:M:" + "b".repeat(4000));
      await sleep(500);
      const after = await merchant.state();
      if (after.intent !== "none") throw new Error(`overlong line set intent ${after.intent}`);
      if (after.heap < before.heap * 0.75) throw new Error("heap dropped sharply on overlong input");
      // Still responsive to a good line afterwards.
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded", { timeout: 3000 });
      merchant.send(co.intentLine);
      await loaded;
      merchant.btn("B");
      return "4KB lines dropped, console still healthy";
    },
  },

  {
    name: "duplicate checkouts: the newest one wins",
    async run(sender, merchant) {
      await enterMode(merchant, "merchant");
      const a = checkout({ lamports: 0.1 * SOL });
      const b = checkout({ lamports: 0.9 * SOL });
      let loaded = merchant.waitFor("intent_loaded");
      merchant.send(a.intentLine);
      await loaded;
      loaded = merchant.waitFor("intent_loaded");
      merchant.send(b.intentLine);
      await loaded;
      const m = await merchant.state();
      if (m.intent !== b.id) throw new Error(`expected newest intent ${b.id}, badge holds ${m.intent}`);
      if (m.lamports !== b.lamports) throw new Error(`amount is ${m.lamports}, expected ${b.lamports}`);
      merchant.btn("B");
      return "second checkout replaced the first cleanly";
    },
  },

  {
    name: "repeated A presses send exactly one approval",
    async run(sender, merchant) {
      await enterMode(sender, "sender");
      await enterMode(merchant, "merchant");
      sender.btn("A");
      await sender.until((s) => s.armed, { what: "sender armed" });
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      merchant.send(co.itemLine);
      await loaded;
      await knock(sender, merchant);
      await sender.until((s) => s.intent === co.id, { what: "charge received", timeout: 4000 });

      const mark = merchant.since();
      // Ten presses as fast as the console will carry them.
      for (let i = 0; i < 10; i++) { sender.btn("A"); await sleep(25); }
      await sleep(2500);

      const approvals = merchant.approvalsSince(mark);
      const forThis = approvals.filter((a) => a.payload.includes(co.id));
      if (forThis.length !== 1) {
        throw new Error(`10 presses produced ${forThis.length} approvals, expected exactly 1`);
      }
      merchant.send(`SP_CONFIRM ${co.id}`);
      await sleep(200);
      return "10 rapid presses -> 1 approval";
    },
  },

  {
    name: "repeated knocks while paired do not disturb the link",
    async run(sender, merchant) {
      await enterMode(sender, "sender");
      await enterMode(merchant, "merchant");
      sender.btn("A");
      await sender.until((s) => s.armed, { what: "sender armed" });
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      merchant.send(co.itemLine);
      await loaded;
      await knock(sender, merchant);
      await sender.until((s) => s.intent === co.id, { what: "charge received", timeout: 4000 });

      for (let i = 0; i < 6; i++) { await knock(sender, merchant); await sleep(120); }
      await sleep(600);

      const s = await sender.state();
      if (s.intent !== co.id) throw new Error(`extra knocks lost the charge (intent=${s.intent})`);

      const approval = merchant.waitForApproval({ timeout: 6000 });
      sender.btn("A");
      const got = await approval;
      if (!got.payload.includes(co.id)) throw new Error("approval did not match the charge");
      merchant.send(`SP_CONFIRM ${co.id}`);
      await sleep(200);
      return "6 extra knocks, link and charge survived";
    },
  },

  {
    name: "unexpected reset restores mode and drops the checkout",
    async run(sender, merchant) {
      // This is the brownout-recovery path: main.c restores the mode from NVS
      // only for BROWNOUT/PANIC/WDT/SW, so the payer is not dumped back to the
      // home screen mid-checkout by a reset they did not ask for. A software
      // restart reports ESP_RST_SW and is the only way to reach it from here.
      await enterMode(merchant, "merchant");
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      await loaded;

      await merchant.softReboot();

      const m = await merchant.state();
      if (m.mode !== "merchant") {
        throw new Error(`mode was ${m.mode} after an unexpected reset, expected merchant restored from NVS`);
      }
      // The mode survives; the money never does.
      if (m.intent !== "none") throw new Error(`stale intent ${m.intent} survived the reset`);
      if (m.armed) throw new Error("badge came back armed");
      if (m.approved !== "none") throw new Error(`stale approval ${m.approved} survived the reset`);

      const co2 = checkout();
      const l2 = merchant.waitFor("intent_loaded", { timeout: 4000 });
      merchant.send(co2.intentLine);
      await l2;
      merchant.btn("B");
      return "mode restored, checkout dropped, still usable";
    },
  },

  {
    name: "deliberate reset lands on home",
    async run(sender, merchant) {
      // An esptool reset reports ESP_RST_EXT, which main.c deliberately treats
      // as a considered restart rather than a fault: it must NOT resume a mode.
      await enterMode(merchant, "merchant");
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      await loaded;

      await merchant.reset();

      const m = await merchant.state();
      if (m.mode !== "home") {
        throw new Error(`mode was ${m.mode} after a deliberate reset, expected home`);
      }
      if (m.intent !== "none") throw new Error(`stale intent ${m.intent} survived the reset`);
      if (!m.wallet) throw new Error("wallet did not survive the reset (NVS)");
      return "landed on home, checkout dropped, wallet kept";
    },
  },

  {
    name: "sender reset mid-flow drops the charge but keeps the wallet",
    async run(sender, merchant) {
      await enterMode(sender, "sender");
      await enterMode(merchant, "merchant");
      sender.btn("A");
      await sender.until((s) => s.armed, { what: "sender armed" });
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      merchant.send(co.itemLine);
      await loaded;
      await knock(sender, merchant);
      await sender.until((s) => s.intent === co.id, { what: "charge received", timeout: 4000 });

      await sender.softReboot();

      const s2 = await sender.state();
      if (s2.mode !== "sender") throw new Error(`sender came back in mode ${s2.mode}, expected sender from NVS`);
      if (s2.intent !== "none") throw new Error(`stale charge ${s2.intent} survived the reset`);
      if (s2.confirming) throw new Error("sender came back mid-confirmation");
      if (!s2.wallet) throw new Error("wallet did not survive the reset (NVS)");
      merchant.btn("B");
      return "charge dropped, wallet and mode kept";
    },
  },

  {
    name: "stale approval for an old intent is refused",
    async run(sender, merchant) {
      // Pay once, then replace the checkout and make sure the merchant will not
      // accept anything still carrying the old intent.
      const first = await payOnce(sender, merchant);
      const co = checkout();
      const loaded = merchant.waitFor("intent_loaded");
      merchant.send(co.intentLine);
      await loaded;

      const mark = merchant.since();
      // The sender still holds nothing; drive a mismatched approval by sending
      // the old intent's id in a fresh charge and checking the merchant's guard.
      const m = await merchant.state();
      if (m.approved !== "none") {
        throw new Error(`new checkout inherited approval ${m.approved} from the previous one`);
      }
      if (m.intent === first.checkout.id) throw new Error("new checkout did not replace the old id");
      merchant.btn("B");
      return "new checkout starts with a clean approval slate";
    },
  },

  {
    name: "three payments back to back",
    async run(sender, merchant) {
      const times = [];
      for (let i = 0; i < 3; i++) {
        const r = await payOnce(sender, merchant, { lamports: (i + 1) * 0.05 * SOL, item: `ROUND_${i + 1}` });
        times.push(r.ms);
        await sleep(300);
      }
      return `3 payments in ${times.join("ms, ")}ms`;
    },
  },
];
