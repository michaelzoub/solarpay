import { constants, createReadStream, createWriteStream, openSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseBadgeAppSource } from "../web/badge-serial.js";
import { encodeLvglIcon } from "../server/badge-assets.js";

const port = process.env.BADGE_PORT || "/dev/cu.usbmodem1101";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

execFileSync("stty", ["-f", port, "115200", "cs8", "-cstopb", "-parenb", "raw", "-echo"]);
const fd = openSync(port, constants.O_RDWR | constants.O_NOCTTY);
const reader = createReadStream(null, { fd, autoClose: false, highWaterMark: 4096 });
const writer = createWriteStream(null, { fd, autoClose: false });
let received = "";

reader.on("data", (chunk) => {
  received += chunk.toString("utf8");
  if (received.length > 65536) received = received.slice(-65536);
});

function write(bytes) {
  return new Promise((resolve, reject) => writer.write(bytes, (error) => error ? reject(error) : resolve()));
}

async function line(command) {
  await write(Buffer.from(`${command}\r`));
}

async function waitFor(pattern, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const index = received.indexOf(pattern);
    if (index >= 0) {
      received = received.slice(index + pattern.length);
      return;
    }
    await pause(20);
  }
  throw new Error(`Badge did not respond with ${pattern}`);
}

async function prompt() {
  received = "";
  await line("");
  try { await waitFor("badge> ", 2500); }
  catch {
    await write(Buffer.from([3]));
    await pause(150);
    received = "";
    await line("");
    await waitFor("badge> ", 5000);
  }
}

async function put(remotePath, bytes) {
  await prompt();
  received = "";
  await line(`put ${remotePath} ${bytes.length}`);
  await waitFor("READY", 5000);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    await write(bytes.subarray(offset, offset + 64));
    if (offset + 64 < bytes.length) await pause(30);
  }
  await waitFor(`OK ${bytes.length}`, 45000);
}

async function install(filename) {
  const app = parseBadgeAppSource(readFileSync(filename, "utf8"));
  const directory = `/littlefs/apps/${app.slug}`;
  console.log(`Installing ${app.name}…`);
  await prompt();
  received = "";
  await line(`mkdir ${directory}`);
  await waitFor("badge> ");
  await put(`${directory}/manifest.cfg`, Buffer.from(app.manifest));
  await put(`${directory}/main.lua`, Buffer.from(app.main));
  const role = app.slug === "solarpay_merchant" ? "merchant" : app.slug === "solarpay_sender" ? "customer" : null;
  if (role) await put(`${directory}/icon.bin`, encodeLvglIcon(role));
  console.log(`Installed ${app.name}.`);
}

try {
  await prompt();
  await line("press HOME");
  await pause(700);
  await install(new URL("../badges/solarpay_customer.lua", import.meta.url));
  await install(new URL("../badges/solarpay_merchant.lua", import.meta.url));
  await prompt();
  received = "";
  await line("reload");
  await waitFor("reload:", 8000);
  console.log("Restarting badge…");
  await line("reboot");
  console.log("SolarPay Sender and Merchant v1.4.0 installed.");
} finally {
  reader.destroy();
  writer.end();
}
