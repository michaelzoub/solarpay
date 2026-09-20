// The laptop half of the SolarPay end-to-end harness.
//
// Drives two badges over USB at once. Everything a badge says arrives as lines;
// everything a test asserts on is either an SP_EVT event or the state dump that
// SP_TEST_STATE returns. Tests wait on events rather than sleeping, so a slow
// radio makes a test slower, not flaky.
//
// Requires firmware built with CONFIG_SOLARPAY_TEST_HARNESS=y; see
// firmware/solarpay/main/Kconfig.projbuild.
import { openSync, closeSync, writeSync, createReadStream, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";

export class Badge extends EventEmitter {
  constructor(name, port) {
    super();
    this.name = name;
    this.port = port;
    this.lines = [];        // every line, in order, with a receive timestamp
    this.events = [];       // parsed SP_EVT only
    this.approvals = [];
    this.identity = null;
    this._buf = "";
    this._open();
  }

  _open() {
    execFileSync("stty", ["-f", this.port, "115200", "cs8", "-cstopb", "-parenb", "raw", "-echo"]);
    this.fd = openSync(this.port, "r+");
    this.rs = createReadStream(null, { fd: this.fd, autoClose: false, highWaterMark: 4096 });
    this.rs.on("data", (chunk) => this._ingest(chunk.toString("utf8")));
    this.rs.on("error", (e) => this.emit("ioerror", e));
  }

  _ingest(text) {
    this._buf += text;
    let i;
    while ((i = this._buf.search(/[\r\n]/)) >= 0) {
      const line = this._buf.slice(0, i);
      this._buf = this._buf.slice(i + 1);
      if (line.trim()) this._line(line.trim());
    }
  }

  _line(line) {
    const at = Date.now();
    this.lines.push({ at, line });
    if (process.env.E2E_TRACE) console.log(`  [${this.name}] ${line}`);

    if (line.startsWith("SP_EVT|")) {
      const ev = { at, raw: line, fields: {} };
      for (const part of line.split("|")) {
        const eq = part.indexOf("=");
        if (eq > 0) ev.fields[part.slice(0, eq)] = part.slice(eq + 1);
      }
      ev.type = ev.fields.type;
      ev.seq = Number(ev.fields.seq);
      this.events.push(ev);
      this.emit("event", ev);
    } else if (line.startsWith("SOLARPAY_APPROVAL:")) {
      const a = { at, raw: line, payload: line.slice("SOLARPAY_APPROVAL:".length) };
      this.approvals.push(a);
      this.emit("approval", a);
    } else if (line.startsWith("SOLARPAY_BADGE:")) {
      const [, role, id] = line.split(":");
      this.identity = { role, id };
      this.emit("identity", this.identity);
    }
    this.emit("line", line);
  }

  send(line) {
    if (this.fd == null) {
      throw new Error(`${this.name}: not attached to ${this.port} (a previous reset left it detached)`);
    }
    if (process.env.E2E_TRACE) console.log(`  [${this.name}] > ${line}`);
    writeSync(this.fd, line + "\n");
  }

  // Resolve on the first event matching `type` that arrives after this call.
  // `where` can further filter on the parsed fields.
  waitFor(type, { timeout = 4000, where = null } = {}) {
    const types = Array.isArray(type) ? type : [type];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("event", onEvent);
        const recent = this.events.slice(-8).map((e) => e.type).join(", ");
        reject(new Error(
          `${this.name}: timed out after ${timeout}ms waiting for ${types.join("|")}` +
          `. Last events: ${recent || "(none)"}`));
      }, timeout);
      const onEvent = (ev) => {
        if (!types.includes(ev.type)) return;
        if (where && !where(ev.fields)) return;
        clearTimeout(timer);
        this.off("event", onEvent);
        resolve(ev);
      };
      this.on("event", onEvent);
    });
  }

  waitForApproval({ timeout = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => { this.off("approval", on); reject(new Error(`${this.name}: no approval within ${timeout}ms`)); },
        timeout);
      const on = (a) => { clearTimeout(timer); this.off("approval", on); resolve(a); };
      this.on("approval", on);
    });
  }

  // The authoritative snapshot. Always prefer this to inferring from events.
  async state({ timeout = 3000 } = {}) {
    const p = this.waitFor("test_state", { timeout });
    this.send("SP_TEST_STATE");
    const ev = await p;
    const f = ev.fields;
    return {
      ...f,
      armed: f.armed === "1",
      sending: f.sending === "1",
      peer: f.peer === "1",
      confirming: f.confirming === "1",
      awaiting: f.awaiting === "1",
      wallet: f.wallet === "1",
      lamports: Number(f.lamports),
      balance: Number(f.balance),
      rssi: Number(f.rssi),
      heap: Number(f.heap),
      resultMs: Number(f.result_ms),
      paidMs: Number(f.paid_ms),
      expiresMs: Number(f.expires_ms),
    };
  }

  btn(name) { this.send(`SP_TEST_BTN ${name}`); }
  impact(mg = 1800) { this.send(`SP_TEST_IMPACT ${mg}`); }

  // Poll `state()` until `pred` holds, so a test can wait on a condition that
  // no single event announces (a cleared intent, a lapsed result window).
  async until(pred, { timeout = 6000, every = 150, what = "condition" } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    for (;;) {
      last = await this.state();
      if (pred(last)) return last;
      if (Date.now() > deadline) {
        throw new Error(`${this.name}: ${what} never held within ${timeout}ms. Last state: ${JSON.stringify(last)}`);
      }
      await sleep(every);
    }
  }

  since() { return { events: this.events.length, lines: this.lines.length, approvals: this.approvals.length }; }
  eventsSince(mark) { return this.events.slice(mark.events); }
  approvalsSince(mark) { return this.approvals.slice(mark.approvals); }

  // Reboot the badge and reattach.
  //
  // Measured on this hardware: an esptool RTS reset does NOT tear down the USB
  // device -- /dev/cu.usbmodem* stays present the whole way through. An earlier
  // version of this waited for the node to disappear first, which simply burned
  // the entire deadline and then threw. So the only thing to wait for is the
  // port becoming openable again.
  //
  // Whatever happens, we reattach before throwing. Leaving this.fd null poisons
  // the Badge for every later scenario, which turns one reset failure into a
  // whole-suite cascade of "fd must be of type number" and hides the real fault.
  async reset({ timeout = 20000 } = {}) {
    const deadline = Date.now() + timeout;
    this.rs.destroy();
    try { closeSync(this.fd); } catch {}
    this.fd = null;

    let resetErr = null;
    try {
      execFileSync(esptoolPython(), ["-m", "esptool", "--port", this.port, "--after", "hard_reset", "chip_id"],
                   { stdio: "ignore", timeout: 15000 });
    } catch (e) {
      resetErr = e;
    }

    await this._reattach(deadline, resetErr);
  }

  // Software reboot via the firmware, which reports ESP_RST_SW and therefore
  // exercises the restore-mode-from-NVS path that an esptool reset cannot.
  async softReboot({ timeout = 20000 } = {}) {
    const deadline = Date.now() + timeout;
    try { this.send("SP_TEST_REBOOT"); } catch {}
    await delay(400);
    this.rs.destroy();
    try { closeSync(this.fd); } catch {}
    this.fd = null;
    await this._reattach(deadline, null);
  }

  // The node stays present but the USB device reattaches underneath it, so an
  // fd opened too eagerly is stale and the first write returns EBADF. Opening
  // is therefore not proof of anything: probe the badge and only accept the
  // attachment once it actually answers.
  async _reattach(deadline, resetErr) {
    let lastErr = null;
    while (Date.now() < deadline) {
      await delay(300);
      if (!existsSync(this.port)) continue;
      try {
        this._buf = "";
        this._open();
      } catch (e) {
        lastErr = e;
        continue;
      }
      try {
        await this.state({ timeout: 2500 });
        if (resetErr) {
          throw new Error(`${this.name}: esptool reset failed on ${this.port}: ${resetErr.message}`);
        }
        return;
      } catch (e) {
        lastErr = e;
        this.rs.destroy();
        try { closeSync(this.fd); } catch {}
        this.fd = null;
      }
    }
    throw new Error(`${this.name}: did not answer on ${this.port} within the deadline after reset: ` +
                    `${lastErr?.message ?? resetErr?.message ?? "no response"}`);
  }

  close() { try { this.rs.destroy(); closeSync(this.fd); } catch {} }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delay = sleep;

// esptool lives in the ESP-IDF virtualenv, not in the system python, so prefer
// IDF's interpreter when the environment points at one.
function esptoolPython() {
  const venv = process.env.IDF_PYTHON_ENV_PATH;
  if (venv) {
    const p = `${venv}/bin/python`;
    if (existsSync(p)) return p;
  }
  return process.env.ESPTOOL_PYTHON || "python3";
}

// A knock is one physical event felt by both badges a few ms apart. Feeding
// both from here is what makes the correlation test honest: the firmware still
// has to agree the two impacts were close enough in time and strength.
export async function knock(a, b, { mg = 1800, skewMs = 20, spread = 0.9 } = {}) {
  a.impact(mg);
  await sleep(skewMs);
  b.impact(Math.round(mg * spread));
}
