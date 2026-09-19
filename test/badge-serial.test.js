import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseBadgeAppSource, parseBadgeLine, parseProvisioningIdentity } from "../web/badge-serial.js";
import { BadgeSerialClient } from "../web/badge-serial.js";

test("parses structured SolarPay badge events inside firmware log prefixes", () => {
  assert.deepEqual(parseBadgeLine("I app[solarpay_terminal]: SP_EVT|v=1|seq=4|type=broadcasting|intent=0123abcd"), {
    kind: "event",
    text: "I app[solarpay_terminal]: SP_EVT|v=1|seq=4|type=broadcasting|intent=0123abcd",
    event: "broadcasting",
    fields: { v: "1", seq: "4", type: "broadcasting", intent: "0123abcd" },
  });
});

test("recognizes current badge identity and approval log formats", () => {
  assert.equal(parseBadgeLine("[solarpay] SOLARPAY_BADGE:merchant:TERM-001").event, "badge_ready");
  assert.deepEqual(parseBadgeLine("SOLARPAY_APPROVAL:SP1:A:deadbeef:PAY-001:nonce123").fields, {
    packet: "SP1:A:deadbeef:PAY-001:nonce123",
  });
});

test("reads the provisioned physical badge ID from prov show output", () => {
  assert.deepEqual(parseProvisioningIdentity("provisioned=1\r\nbadge_id=lilac-hickory-atlas-west\r\ndisplay_name=Michael\r\n"), {
    badgeId: "lilac-hickory-atlas-west",
  });
  assert.throws(() => parseProvisioningIdentity("provisioned=0\n"), /valid provisioned badge ID/);
});

test("removes terminal escapes and classifies firmware errors", () => {
  assert.deepEqual(parseBadgeLine("\u001b[31mLua error: boom\u001b[0m"), {
    kind: "error",
    text: "Lua error: boom",
  });
  assert.equal(parseBadgeLine("  \r"), null);
});

test("preserves ordinary firmware output instead of filtering it", () => {
  assert.deepEqual(parseBadgeLine("I (605) LVGL: Starting LVGL task"), {
    kind: "log",
    text: "I (605) LVGL: Starting LVGL task",
  });
});

test("badge apps retain structured coverage for meaningful event classes", async () => {
  const [customer, terminal] = await Promise.all([
    readFile(new URL("../badges/customer.lua", import.meta.url), "utf8"),
    readFile(new URL("../badges/terminal.lua", import.meta.url), "utf8"),
  ]);
  for (const event of ["app_enter", "app_exit", "button", "radio_ready", "radio_unavailable", "radio_received", "radio_dropped", "intent_expired", "proximity", "proximity_lost"]) {
    assert.match(customer, new RegExp(`emit_event\\(\\"${event}\\"`), `customer must log ${event}`);
    assert.match(terminal, new RegExp(`emit_event\\(\\"${event}\\"`), `terminal must log ${event}`);
  }
  for (const event of ["intent_received", "intent_rejected", "intent_declined", "approval_queued", "approval_rejected", "approval_send_failed"]) {
    assert.match(customer, new RegExp(`emit_event\\(\\"${event}\\"`), `customer must log ${event}`);
  }
  for (const event of ["broadcast_requested", "broadcast_queued", "broadcast_failed", "intent_cancelled", "approval_received", "approval_ignored"]) {
    assert.match(terminal, new RegExp(`emit_event\\(\\"${event}\\"`), `terminal must log ${event}`);
  }
});

test("touch diagnostic combines motion and radio for badge contact and retains passive NFC", async () => {
  const source = await readFile(new URL("../badges/tap_logger.lua", import.meta.url), "utf8");
  assert.match(source, /slug=solarpay_tap_logger/);
  assert.match(source, /badge\.nfc\.enable\(\)/);
  assert.match(source, /badge\.nfc\.card\(\)/);
  assert.match(source, /badge\.sensor\.tap\(\)/);
  assert.match(source, /badge\.radio\.on_recv/);
  assert.match(source, /emit\("nfc_ready"/);
  assert.match(source, /emit\("nfc_unavailable"/);
  assert.match(source, /emit\("nfc_tap"/);
  assert.match(source, /emit\("badge_touch"/);
  assert.match(source, /emit\("touch_unpaired"/);
  assert.match(source, /local_badge_id=/);
  assert.match(source, /peer_uid=/);
  assert.match(source, /emit\("button"/);
  assert.match(source, /emit\("app_exit"/);
});

test("SolarPay app paints an 8-bit stateful UI and emits real badge touch and laptop events", async () => {
  const [customer, merchant] = await Promise.all([
    readFile(new URL("../badges/solarpay_customer.lua", import.meta.url), "utf8"),
    readFile(new URL("../badges/solarpay_merchant.lua", import.meta.url), "utf8"),
  ]);
  for (const source of [customer, merchant]) {
    assert.ok(Buffer.byteLength(source) < 13 * 1024, "standalone app must stay below the validated 96 KB heap source envelope");
    assert.match(source, /heap_kb=96/);
    assert.doesNotMatch(source, /\bpcall\s*\(/);
    assert.match(source, /badge\.ui\.box\(root,\s*320,\s*240\)/);
    assert.match(source, /"solarpay"/);
    assert.match(source, /badge\.radio\.on_recv/);
    assert.doesNotMatch(source, /badge\.nfc\./, "passive NFC diagnostics must not consume standalone startup memory");
    assert.match(source, /emit\("laptop_connected"/);
    assert.match(source, /emit\("laptop_disconnected"/);
    assert.match(source, /badge\.input\.BUTTON\.AUX1/);
    assert.match(source, /if button==badge\.input\.BUTTON\.AUX1 then[\s\S]*?return/, "USB heartbeat must bypass routine button logging and repainting");
  }
  assert.match(customer, /slug=solarpay_sender\n/);
  assert.match(customer, /name=SolarPay Sender\n/);
  assert.match(customer, /icon=GIVE\n/);
  assert.match(customer, /"CHECK ITEM AND AMOUNT"/);
  assert.match(customer, /"READY TO PAY"/);
  assert.match(customer, /"SEND COINS"/);
  assert.match(customer, /"A PAY    B DECLINE"/);
  assert.match(customer, /\^SP1:M:/);
  assert.match(customer, /if not qr then qr\s*=\s*badge\.ui\.image\(card,\s*"qr\.bin"\)/, "QR allocation must be deferred until requested");
  assert.match(customer, /badge\.sensor\.tap\(\)/);
  assert.match(customer, /badge\.sensor\.shake\(\)/, "a physical bump should accept either firmware motion detector");
  assert.match(customer, /emit\("proximity"/);
  assert.match(customer, /emit\("proximity_lost"/);
  assert.match(customer, /merchant_zone/);
  assert.match(customer, /badge\.led\.set\(1,0,level,level\)/, "sender must illuminate its left facing edge");
  assert.match(customer, /"< TAP LEFT EDGE ON MERCHANT"/);
  assert.match(customer, /elapsed<1080/, "approval must render three sync-style green pulses");
  assert.match(customer, /apkt,\s*auntil,\s*anext/, "tap approval must be retried across lossy radio delivery");
  assert.match(customer, /badge\.radio\.send\(apkt\)/, "tap approval retry must resend the same authenticated packet");
  assert.match(customer, /badge\.radio\.send\(beacon\)/, "sender beacon must reuse a cached packet");
  assert.match(customer, /emit\("touch_unpaired"/);
  assert.doesNotMatch(customer, /badge\.fs\.read\("intent\.txt"\)/);
  assert.match(merchant, /"\[ USB RECEIVE MODE \]"/);
  assert.match(merchant, /"\[ CHECKOUT READY \]"/);
  assert.match(merchant, /"< BUMP TO PAY >"/);
  assert.doesNotMatch(merchant, /LISTENING FOR APPROVAL|NO PAYER NEARBY/);
  assert.match(merchant, /badge\.fs\.read\("intent\.txt"\)/);
  assert.match(merchant, /emit\("approval_received"/);
  assert.match(merchant, /if approved==a then return end/, "merchant must deduplicate retried approvals");
  assert.match(merchant, /emit\("settlement_confirmed"/);
  assert.match(merchant, /emit\("settlement_failed"/);
  assert.match(merchant, /emit\("proximity"/);
  assert.match(merchant, /emit\("proximity_lost"/);
  assert.match(merchant, /if payer_mac and now-payer_seen>=2600/, "proximity expiry must not depend on an approval identity");
  assert.match(merchant, /badge\.led\.set\(2,0,level,level\)/, "merchant must illuminate its right facing edge");
  assert.match(merchant, /"TAP ON RIGHT EDGE  >>>"/);
  assert.match(merchant, /level=90\+math\.floor/, "merchant checkout must glow brightly while waiting for a badge");
  assert.match(merchant, /elapsed<1080/, "approval must render three sync-style green pulses");
  assert.doesNotMatch(merchant, /badge\.sensor\.tap\(\)/);
  assert.match(merchant, /name=SolarPay Merchant\n/);
  assert.match(merchant, /slug=solarpay_merchant\n/);
  assert.match(merchant, /icon=SHOP\n/);
  assert.match(merchant, /if radio_ok and packet and now<expires/);
  assert.match(merchant, /badge\.radio\.send\(beacon\)/, "merchant beacon must reuse a cached packet");
  assert.doesNotMatch(merchant, /if badge\.radio\.send\(packet\) then emit\("broadcast_queued"/, "radio retries must not allocate and log on every send");
});

test("parses a combined Lua badge app into uploadable manifest and code", async () => {
  const source = await readFile(new URL("../badges/tap_logger.lua", import.meta.url), "utf8");
  const app = parseBadgeAppSource(source);
  assert.equal(app.slug, "solarpay_tap_logger");
  assert.equal(app.name, "SolarPay Touch Test");
  assert.match(app.manifest, /^slug=solarpay_tap_logger/m);
  assert.match(app.main, /function on_enter\(root\)/);
  assert.doesNotMatch(app.main, /badge-app/);
});

test("rejects malformed or unsafe Lua app bundles before serial upload", () => {
  assert.throws(() => parseBadgeAppSource("print('missing manifest')"), /manifest header/);
  assert.throws(() => parseBadgeAppSource("--[==[badge-app\nslug=Bad Slug\nname=Bad\n]==]\nprint('x')"), /invalid slug/);
  assert.throws(() => parseBadgeAppSource("--[==[badge-app\nslug=ok\nname=Empty\n]==]\n"), /main\.lua/);
});

test("merchant intent bridge writes into the SolarPay app and triggers START", async () => {
  const writes = [];
  const client = new BadgeSerialClient();
  client.writer = { write: async (bytes) => writes.push(new TextDecoder().decode(bytes)) };
  client.waitFor = async () => {};
  await client.writeAppFile("solarpay_merchant", "intent.txt", "SP1:I:deadbeef:1000:90:nonce12345:TE\n", { triggerButton: "START" });
  const output = writes.join("");
  assert.match(output, /put \/littlefs\/apps\/solarpay_merchant\/intent\.txt/);
  assert.match(output, /SP1:I:deadbeef:1000:90:nonce12345:TE/);
  assert.match(output, /press START/);
});

test("console acquisition recovers a running or interrupted badge with Ctrl-C", async () => {
  const writes = [];
  const client = new BadgeSerialClient();
  client.writer = { write: async (bytes) => writes.push([...bytes]) };
  let waits = 0;
  client.waitFor = async () => {
    waits++;
    if (waits === 1) throw new Error("not ready");
  };
  await client.ensurePrompt();
  assert.ok(writes.some((bytes) => bytes.length === 1 && bytes[0] === 0x03));
  assert.equal(waits, 2);
});

test("a dropped bulk acknowledgement is recovered and retried once", async () => {
  const client = new BadgeSerialClient();
  const commands = [];
  client.writer = { write: async () => {} };
  client.ensurePrompt = async () => {};
  client.sendLine = async (line) => commands.push(line);
  client.sendBytes = async () => {};
  client.resyncAfterTransfer = async () => true;
  let okWaits = 0;
  client.waitFor = async (pattern) => {
    if (pattern.startsWith("OK ") && okWaits++ === 0) throw new Error("dropped acknowledgement");
  };
  let retries = 0;
  await client.putFile("/littlefs/apps/solarpay_merchant/main.lua", new Uint8Array(13778), () => retries++);
  assert.equal(commands.filter((line) => line.startsWith("put ")).length, 2);
  assert.equal(retries, 1);
});

test("role-specific app installation completes upload, reload, and reboot", async () => {
  const source = await readFile(new URL("../badges/solarpay_merchant.lua", import.meta.url), "utf8");
  const client = new BadgeSerialClient();
  const commands = [];
  let pending = null;
  client.writer = {
    write: async (bytes) => {
      if (pending) {
        pending.received += bytes.length;
        if (pending.received >= pending.length) {
          client.consume(`OK ${pending.length}\r\nbadge> `);
          pending = null;
        }
        return;
      }
      const command = new TextDecoder().decode(bytes).replace(/\r$/, "");
      commands.push(command);
      if (command === "") client.consume("badge> ");
      else if (command.startsWith("mkdir ")) client.consume("badge> ");
      else if (command.startsWith("put ")) {
        const length = Number(command.split(" ").at(-1));
        pending = { length, received: 0 };
        client.consume("READY\r\n");
      } else if (command === "reload") client.consume("reload: ok\r\nbadge> ");
      else if (command === "reboot") client.consume("booting\r\nbadge> ");
    },
  };
  const stages = [];
  await client.installApp(source, ({ stage }) => stages.push(stage));
  assert.ok(commands.includes("mkdir /littlefs/apps/solarpay_merchant"));
  assert.ok(commands.includes("press HOME"));
  assert.ok(commands.includes("reload"));
  assert.ok(commands.includes("reboot"));
  assert.deepEqual(stages, ["syncing", "uploading", "uploading", "reloading", "restarting", "complete"]);
});
