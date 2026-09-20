// Run the SolarPay end-to-end suite against two physical badges.
//
//   node tools/e2e/run.js                 one pass
//   node tools/e2e/run.js --loops 5       five passes
//   node tools/e2e/run.js --only pair     scenarios whose name matches
//   E2E_TRACE=1 node tools/e2e/run.js     echo every serial line
//
// Ports default to the two badges this project is developed against; override
// with SENDER_PORT / MERCHANT_PORT.
import { Badge, sleep } from "./rig.js";
import { scenarios, reset } from "./scenarios.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const loops = Number(flag("loops", "1"));
const only = flag("only", null);

const SENDER_PORT = process.env.SENDER_PORT || "/dev/cu.usbmodem101";
const MERCHANT_PORT = process.env.MERCHANT_PORT || "/dev/cu.usbmodem1101";
const WALLET = "SoLaRPay1111111111111111111111111111111111";

const sender = new Badge("sender", SENDER_PORT);
const merchant = new Badge("merchant", MERCHANT_PORT);

const results = [];
let passed = 0, failed = 0;

function line(ch = "-") { console.log(ch.repeat(72)); }

async function preflight() {
  console.log(`sender   ${SENDER_PORT}`);
  console.log(`merchant ${MERCHANT_PORT}`);
  for (const b of [sender, merchant]) {
    b.send("SP_ID");
    b.send(`SP_WALLET ${WALLET} ${5 * 1_000_000_000}`);
  }
  await sleep(600);
  for (const b of [sender, merchant]) {
    let s;
    try {
      s = await b.state({ timeout: 4000 });
    } catch (e) {
      throw new Error(
        `${b.name} on ${b.port} did not answer SP_TEST_STATE. Is it running a build with ` +
        `CONFIG_SOLARPAY_TEST_HARNESS=y? (${e.message})`);
    }
    if (!s.wallet) throw new Error(`${b.name}: wallet did not stick`);
    console.log(`${b.name.padEnd(9)} id=${b.identity?.id ?? "?"} mode=${s.mode} heap=${s.heap}`);
  }
  line();
}

async function main() {
  await preflight();
  const startHeap = {
    sender: (await sender.state()).heap,
    merchant: (await merchant.state()).heap,
  };

  for (let loop = 1; loop <= loops; loop++) {
    if (loops > 1) { line("="); console.log(`PASS ${loop} of ${loops}`); line("="); }

    for (const sc of scenarios) {
      if (only && !sc.name.toLowerCase().includes(only.toLowerCase())) continue;
      process.stdout.write(`  ${sc.name.padEnd(56)}`);
      const t0 = Date.now();
      try {
        await reset(sender, merchant);
        const note = await sc.run(sender, merchant);
        const ms = Date.now() - t0;
        console.log(`PASS  ${String(ms).padStart(5)}ms  ${note ?? ""}`);
        passed++;
        results.push({ loop, name: sc.name, ok: true, ms, note });
      } catch (e) {
        const ms = Date.now() - t0;
        console.log(`FAIL  ${String(ms).padStart(5)}ms`);
        console.log(`        ${e.message}`);
        failed++;
        results.push({ loop, name: sc.name, ok: false, ms, error: e.message });
        // Leave both badges somewhere sane so one failure does not cascade.
        try { await reset(sender, merchant); } catch {}
      }
    }
  }

  line("=");
  const endHeap = {
    sender: (await sender.state()).heap,
    merchant: (await merchant.state()).heap,
  };
  for (const who of ["sender", "merchant"]) {
    const d = endHeap[who] - startHeap[who];
    console.log(`${who.padEnd(9)} heap ${startHeap[who]} -> ${endHeap[who]} (${d >= 0 ? "+" : ""}${d})`);
  }
  console.log(`\n${passed} passed, ${failed} failed, ${loops} pass(es)`);

  if (failed) {
    line();
    console.log("Failures:");
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  [pass ${r.loop}] ${r.name}\n      ${r.error}`);
    }
  }
  sender.close();
  merchant.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("\nharness error:", e.message);
  sender.close();
  merchant.close();
  process.exit(2);
});
