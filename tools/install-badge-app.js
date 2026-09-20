// Install one or more badge apps over the USB console.
//
//   node tools/install-badge-app.js badges/solarpay_pair.lua [more.lua ...]
//
// Sources with a --#include directive are built first. Transport matches the
// official IDE's rules (bare CR, small writes with pauses, reload, reboot).
import { constants, openSync, createReadStream, createWriteStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseBadgeAppSource } from "../web/badge-serial.js";
import { readBadgeApp } from "../server/badge-source.js";

const port = process.env.BADGE_PORT || "/dev/cu.usbmodem1101";
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node tools/install-badge-app.js <app.lua> [...]");
  process.exit(1);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// A cu.* device is not opened exclusively on macOS, so a second installer (or a
// forgotten `badge:logs`, or the Badge IDE) opens it happily and then races us
// for every byte the badge sends. The symptom is silence, which used to be
// reported as "the badge is asleep" -- a confident wrong answer that sends you
// power-cycling hardware that was never the problem. Name the real owner.
function requirePortIsFree() {
  let holders;
  try {
    holders = execFileSync("lsof", ["-t", port], { encoding: "utf8" });
  } catch {
    return; // lsof exits non-zero when nobody holds the port, which is the good case.
  }
  const others = holders.split("\n").map((pid) => pid.trim())
    .filter((pid) => pid && pid !== String(process.pid));
  if (others.length === 0) return;
  const described = others.map((pid) => {
    let command = "";
    try { command = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).trim(); }
    catch { command = "(process has since exited)"; }
    return `    ${pid}  ${command}`;
  }).join("\n");
  throw new Error(
    `another process is already holding ${port}:\n${described}\n` +
    "  That process is consuming the badge's replies, so this run would see silence.\n" +
    `  Close it (or: kill ${others.join(" ")}), then run this again.`
  );
}

requirePortIsFree();
execFileSync("stty", ["-f", port, "115200", "cs8", "-cstopb", "-parenb", "raw", "-echo"]);
const fd = openSync(port, constants.O_RDWR | constants.O_NOCTTY);
const reader = createReadStream(null, { fd, autoClose: false, highWaterMark: 4096 });
const writer = createWriteStream(null, { fd, autoClose: false });
let received = "";
reader.on("data", (c) => {
  received += c.toString("utf8");
  if (received.length > 65536) received = received.slice(-65536);
});

const WRITE_TIMEOUT_MS = 10000;
const write = (b) => new Promise((res, rej) => {
  // If the badge stops draining the port, write()'s callback never fires and
  // every timeout below it is unreachable, so the installer hangs forever
  // holding the device. Fail loudly instead.
  const timer = setTimeout(() => rej(new Error(
    `the badge stopped accepting data on ${port} after ${WRITE_TIMEOUT_MS} ms.\n` +
    "  Power-cycle the badge, wait for the launcher, then run this again."
  )), WRITE_TIMEOUT_MS);
  writer.write(b, (e) => { clearTimeout(timer); e ? rej(e) : res(); });
});
const line = (cmd) => write(Buffer.from(`${cmd}\r`));

async function waitFor(pattern, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const i = received.indexOf(pattern);
    if (i >= 0) { received = received.slice(i + pattern.length); return; }
    await pause(20);
  }
  throw new Error(`badge did not respond with ${JSON.stringify(pattern)}`);
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

// The badge sleeps after 300 s idle and only START wakes it. While asleep the
// USB device stays enumerated but the console answers nothing, so a transfer
// started then stalls forever inside put(). Check first and say so plainly.
async function requireAwake() {
  try {
    await prompt();
  } catch {
    throw new Error(
      "the badge is not answering its console.\n" +
      "  It is most likely asleep: press START on the badge (or power-cycle it),\n" +
      "  wait for the launcher, then run this again."
    );
  }
}

// `put` has no receive timeout on the badge: it blocks until the declared byte
// count arrives. An interrupted transfer therefore eats everything sent
// afterwards, including the next command. On failure, top the transfer up with
// padding so the console can reach a prompt again.
async function put(path, bytes) {
  await prompt();
  received = "";
  await line(`put ${path} ${bytes.length}`);
  await waitFor("READY", 5000);
  let written = 0;
  try {
    for (let off = 0; off < bytes.length; off += 64) {
      const chunk = bytes.subarray(off, off + 64);
      await write(chunk);
      written += chunk.length;
      if (off + 64 < bytes.length) await pause(30);
    }
    await waitFor(`OK ${bytes.length}`, 60000);
  } catch (error) {
    const missing = bytes.length - written;
    if (missing > 0) {
      process.stdout.write(`  transfer stalled, padding ${missing} bytes to unwedge the console\n`);
      for (let off = 0; off < missing; off += 64) {
        await write(Buffer.alloc(Math.min(64, missing - off), 0x20));
        await pause(30);
      }
    }
    throw error;
  }
}

try {
  await requireAwake();
  // Return to the launcher first. A running Lua app shares the UI task with the
  // console, and its radio/LED work drops bytes out of the 256-byte RX ring
  // during a large transfer.
  await line("press HOME");
  await pause(700);
  await prompt();
  for (const file of files) {
    const path = resolve(file);
    const app = parseBadgeAppSource(readBadgeApp(path));
    const dir = `/littlefs/apps/${app.slug}`;
    console.log(`installing ${app.name} (${app.slug}), ${Buffer.byteLength(app.main)} bytes`);
    await prompt();
    received = "";
    await line(`mkdir ${dir}`);
    await waitFor("badge> ");
    await put(`${dir}/manifest.cfg`, Buffer.from(app.manifest));
    await put(`${dir}/main.lua`, Buffer.from(app.main));
  }
  await prompt();
  received = "";
  await line("reload");
  await waitFor("reload:", 8000);
  console.log("rebooting");
  await line("reboot");
  await pause(500);
  console.log("done");
} finally {
  reader.destroy();
  writer.end();
}
