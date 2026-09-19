const BADGE_USB_FILTER = { usbVendorId: 0x303a, usbProductId: 0x1001 };
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
// Use more margin than the official IDE's 128 B / 20 ms pacing. SolarPay's
// role apps are larger and an older running app may still be emitting logs
// while the console enters put mode.
const WRITE_CHUNK = 64;
const WRITE_PAUSE_MS = 30;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function webSerialSupported() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export function parseBadgeAppSource(input) {
  let source = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const fenced = source.match(/^```(?:lua)?[ \t]*\n([\s\S]*?)\n```$/);
  if (fenced) source = fenced[1];
  const open = "--[==[badge-app\n";
  const close = "\n]==]";
  if (!source.startsWith(open)) throw new Error("Lua app is missing its badge-app manifest header.");
  const end = source.indexOf(close, open.length);
  if (end < 0) throw new Error("Lua app manifest is missing the ]==] closing line.");
  const manifest = source.slice(open.length, end).trim() + "\n";
  const mainSource = source.slice(end + close.length).replace(/^\n+/, "").trim();
  const main = mainSource ? mainSource + "\n" : "";
  const fields = Object.fromEntries(manifest.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Invalid manifest line: ${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(fields.slug || "")) throw new Error("Lua app has an invalid slug.");
  if (!fields.name) throw new Error("Lua app manifest is missing name=.");
  if (!main.trim()) throw new Error("Lua app does not contain main.lua code.");
  const encoder = new TextEncoder();
  if (encoder.encode(main).length > 64 * 1024) throw new Error("main.lua exceeds the badge's 64 KiB limit.");
  return { slug: fields.slug, name: fields.name, manifest, main };
}

export function parseBadgeLine(input) {
  const text = input.replace(ANSI_ESCAPE, "").replace(/\r/g, "").trim();
  if (!text) return null;

  const eventAt = text.indexOf("SP_EVT|");
  if (eventAt >= 0) {
    const fields = Object.fromEntries(text.slice(eventAt + 7).split("|").map((part) => {
      const separator = part.indexOf("=");
      return separator < 0 ? [part, true] : [part.slice(0, separator), part.slice(separator + 1)];
    }));
    return { kind: "event", text, event: fields.type || "event", fields };
  }

  const approvalAt = text.indexOf("SOLARPAY_APPROVAL:");
  if (approvalAt >= 0) {
    const packet = text.slice(approvalAt + "SOLARPAY_APPROVAL:".length).trim();
    return { kind: "event", text, event: "approval", fields: { packet } };
  }

  const identityAt = text.indexOf("SOLARPAY_BADGE:");
  if (identityAt >= 0) {
    const [role = "unknown", badgeId = "unknown"] = text.slice(identityAt + "SOLARPAY_BADGE:".length).trim().split(":");
    return { kind: "event", text, event: "badge_ready", fields: { role, badgeId } };
  }

  const lower = text.toLowerCase();
  const kind = lower.includes("error") || lower.includes("failed") || lower.includes("panic") ? "error"
    : lower.includes("badge> ") || lower.startsWith("badge>") ? "console"
      : "log";
  return { kind, text };
}

export function parseProvisioningIdentity(input) {
  const fields = Object.fromEntries(input.replace(ANSI_ESCAPE, "").replace(/\r/g, "").split("\n").map((line) => {
    const match = line.trim().match(/^([a-z_]+)=(.*)$/);
    return match ? [match[1], match[2].trim()] : null;
  }).filter(Boolean));
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(fields.badge_id || "")) throw new Error("The connected badge does not have a valid provisioned badge ID.");
  return { badgeId: fields.badge_id };
}

export class BadgeSerialClient extends EventTarget {
  port = null;
  reader = null;
  writer = null;
  readTask = null;
  disconnecting = false;
  buffer = "";
  matchBuffer = "";
  installing = false;

  async connect() {
    if (!webSerialSupported()) throw new Error("Web Serial requires desktop Chrome or Edge.");
    if (this.port) return this.info();

    this.emitStatus("requesting", "Choose USB JTAG/serial debug unit in the device picker.");
    const port = await navigator.serial.requestPort({ filters: [BADGE_USB_FILTER] });
    await port.open({ baudRate: 115200, bufferSize: 4096 });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.disconnecting = false;
    this.emitStatus("connected", "Listening at 115200 baud.");
    this.readTask = this.readLoop();
    return this.info();
  }

  async disconnect() {
    this.disconnecting = true;
    try { await this.reader?.cancel(); } catch {}
    try { await this.readTask; } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
    this.reader = null;
    this.readTask = null;
    this.writer = null;
    this.port = null;
    this.buffer = "";
    this.matchBuffer = "";
    this.emitStatus("disconnected", "Serial port closed.");
  }

  info() {
    const usb = this.port?.getInfo?.() || {};
    return { usbVendorId: usb.usbVendorId, usbProductId: usb.usbProductId };
  }

  async readLoop() {
    const decoder = new TextDecoder();
    try {
      while (this.port?.readable && !this.disconnecting) {
        this.reader = this.port.readable.getReader();
        try {
          while (!this.disconnecting) {
            const { value, done } = await this.reader.read();
            if (done) break;
            this.consume(decoder.decode(value, { stream: true }));
          }
        } catch (error) {
          if (!this.disconnecting) this.emitStatus("error", error.message || "Serial read failed.");
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } finally {
      const tail = decoder.decode();
      if (tail) this.consume(tail);
      if (this.buffer.trim()) this.emitLine(this.buffer);
      this.buffer = "";
      if (!this.disconnecting) {
        try { this.writer?.releaseLock(); } catch {}
        this.writer = null;
        this.port = null;
        this.emitStatus("disconnected", "Badge disconnected.");
      }
    }
  }

  consume(chunk) {
    this.matchBuffer += chunk;
    if (this.matchBuffer.length > 32768) this.matchBuffer = this.matchBuffer.slice(-32768);
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) this.emitLine(line);
  }

  emitLine(line) {
    const parsed = parseBadgeLine(line);
    if (parsed) this.dispatchEvent(new CustomEvent("line", { detail: parsed }));
  }

  emitStatus(state, message) {
    this.dispatchEvent(new CustomEvent("status", { detail: { state, message } }));
  }

  async sendLine(line, { silent = false } = {}) {
    if (!this.writer) throw new Error("Badge is not connected.");
    await this.writer.write(new TextEncoder().encode(line + "\r"));
    if (!silent) this.dispatchEvent(new CustomEvent("line", { detail: { kind: "sent", text: `>> ${line || "(enter)"}` } }));
  }

  async sendBytes(bytes) {
    if (!this.writer) throw new Error("Badge is not connected.");
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK) {
      await this.writer.write(bytes.slice(offset, offset + WRITE_CHUNK));
      if (offset + WRITE_CHUNK < bytes.length) await delay(WRITE_PAUSE_MS);
    }
  }

  async sendBreak() {
    if (!this.writer) throw new Error("Badge is not connected.");
    await this.writer.write(new Uint8Array([0x03]));
    this.dispatchEvent(new CustomEvent("line", { detail: { kind: "sent", text: ">> ^C" } }));
  }

  async waitFor(pattern, timeoutMs = 5000) {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const index = this.matchBuffer.indexOf(pattern);
      if (index >= 0) {
        const matched = this.matchBuffer.slice(0, index);
        this.matchBuffer = this.matchBuffer.slice(index + pattern.length);
        return matched;
      }
      await delay(20);
    }
    const tail = this.matchBuffer.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "").replace(/[\r\n]+/g, " ").trim().slice(-240);
    throw new Error(`Badge did not respond with ${pattern}.${tail ? ` Last output: ${tail}` : ""}`);
  }

  async ensurePrompt() {
    if (!this.writer) throw new Error("Connect the badge before continuing.");
    for (let attempt = 0; attempt < 3; attempt++) {
      this.matchBuffer = "";
      if (attempt === 1) {
        await this.sendBreak();
        await delay(150);
      }
      await this.sendLine("", { silent: true });
      try {
        await this.waitFor("badge> ", attempt === 0 ? 2000 : 3500);
        return;
      } catch {}
    }
    throw new Error("Badge console is not ready. Turn the badge off, keep USB connected, turn it on normally without holding START, wait for the launcher, then try again. Close the Badge IDE and any other serial monitor first.");
  }

  // (The stock firmware's "prov show" identity read lived here. Native firmware
  // answers SP_ID instead; see readBadgeIdentity() below.)

  async resyncAfterTransfer(pendingBytes = 0) {
    try {
      if (pendingBytes > 0) await this.sendBytes(new Uint8Array(pendingBytes));
      await this.ensurePrompt();
      return true;
    } catch {
      return false;
    }
  }

  async putFile(remotePath, bytes, onRetry = () => {}) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      let pendingBytes = 0;
      try {
        await this.ensurePrompt();
        this.matchBuffer = "";
        await this.sendLine(`put ${remotePath} ${bytes.length}`);
        await this.waitFor("READY", 5000);
        pendingBytes = bytes.length;
        await this.sendBytes(bytes);
        await this.waitFor(`OK ${bytes.length}`, 45000);
        return;
      } catch (error) {
        lastError = error;
        const recovered = await this.resyncAfterTransfer(pendingBytes);
        if (attempt === 0 && recovered) {
          onRetry(error);
          continue;
        }
        const recovery = recovered ? "The console recovered, but the retry also failed." : "Restart the badge normally before retrying.";
        error.message = `${error.message} ${recovery}`;
        throw error;
      }
    }
    throw lastError;
  }

  // --- native SolarPay firmware -------------------------------------------
  // The stock firmware took the checkout as a file written through its console.
  // The native firmware has no filesystem console, so the same content goes
  // over as plain lines. Callers keep passing the SP1: packets they always did.
  async pushCheckout(content) {
    if (!this.writer) throw new Error("Connect the badge before sending a checkout.");
    const lines = String(content).split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error("Empty checkout payload.");
    for (const line of lines) {
      if (line.startsWith("SP1:I:"))      await this.sendLine(`SP_INTENT ${line}`);
      else if (line.startsWith("SP1:M:")) await this.sendLine(`SP_ITEM ${line}`);
      else if (line.startsWith("SP1:C:")) await this.sendLine(`SP_CONFIRM ${line.slice(6)}`);
      else if (line.startsWith("SP1:E:")) await this.sendLine(`SP_FAIL ${line.slice(6)}`);
      else throw new Error(`Unrecognised checkout line: ${line.slice(0, 24)}`);
      await delay(40);
    }
  }

  // Push the wallet and balance the sender shows. The badge keeps these in NVS,
  // so a sender provisioned once over USB still has them on battery.
  async provisionWallet(address, lamports) {
    if (!this.writer) throw new Error("Connect the badge before provisioning.");
    if (!address) return;
    await this.sendLine(`SP_WALLET ${address} ${Math.max(0, Math.round(lamports || 0))}`);
  }

  // Resolve on the next parsed line of a given event kind. The raw waitFor()
  // matches a substring and returns everything BEFORE it, which is useless for
  // reading a value out of the line that follows the marker.
  waitForEvent(eventName, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeEventListener("line", onLine);
        reject(new Error(`The badge did not send ${eventName} within ${timeoutMs} ms.`));
      }, timeoutMs);
      const onLine = ({ detail }) => {
        if (detail?.kind !== "event" || detail.event !== eventName) return;
        clearTimeout(timer);
        this.removeEventListener("line", onLine);
        resolve(detail.fields || {});
      };
      this.addEventListener("line", onLine);
    });
  }

  // The native firmware has no "badge> " prompt. Readiness is proven by asking
  // for the identity line instead.
  async ensureReady(timeout = 4000) {
    await this.readBadgeIdentity(timeout);
    return true;
  }

  async readBadgeIdentity(timeoutMs = 4000) {
    if (!this.writer) throw new Error("Connect the badge before reading its identity.");
    let lastError;
    // The badge announces itself unprompted at boot too, so a couple of tries
    // covers both a freshly reset badge and one that has been running a while.
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = this.waitForEvent("badge_ready", timeoutMs);
      await this.sendLine("SP_ID");
      try {
        const fields = await pending;
        const badgeId = (fields.badgeId || "").trim();
        if (/^[0-9a-f]{12}$/i.test(badgeId)) {
          return { role: (fields.role || "customer").trim(), badgeId };
        }
        lastError = new Error(`The badge reported an unusable id: "${badgeId}".`);
      } catch (error) {
        lastError = error;
      }
      await delay(250);
    }
    throw new Error(`${lastError?.message || "The badge did not report an identity."} Check it is powered on, running SolarPay firmware, and that no other serial monitor holds the port.`);
  }

  async writeAppFile(slug, path, content, { triggerButton } = {}) {
    if (!this.writer) throw new Error("Connect the badge before sending app data.");
    if (this.installing) throw new Error("Another badge upload is already running.");
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(slug)) throw new Error("Invalid app slug.");
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(path)) throw new Error("Invalid app data path.");
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    if (!(bytes instanceof Uint8Array) || bytes.length > 16 * 1024) throw new Error("App data must be at most 16 KiB.");
    this.installing = true;
    try {
      await this.putFile(`/littlefs/apps/${slug}/${path}`, bytes);
      if (triggerButton) await this.sendLine(`press ${triggerButton}`);
    } finally {
      this.installing = false;
    }
  }

  async installApp(source, onProgress = () => {}, extraFiles = []) {
    if (!this.writer) throw new Error("Connect the badge before installing an app.");
    if (this.installing) throw new Error("Another badge upload is already running.");
    const app = parseBadgeAppSource(source);
    const encoder = new TextEncoder();
    const files = [
      ["manifest.cfg", encoder.encode(app.manifest)],
      ["main.lua", encoder.encode(app.main)],
    ];
    for (const file of extraFiles) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(file.path || "")) throw new Error(`Invalid app asset path: ${file.path || "(empty)"}`);
      if (!(file.bytes instanceof Uint8Array)) throw new Error(`App asset ${file.path} is not binary data.`);
      if (file.bytes.length > 16 * 1024) throw new Error(`App asset ${file.path} exceeds 16 KiB.`);
      files.push([file.path, file.bytes]);
    }
    this.installing = true;
    try {
      onProgress({ stage: "syncing", message: "Checking badge console…", app });
      await this.ensurePrompt();

      // Stop an older copy before overwriting it. This frees radio/NFC memory
      // and prevents app logs from competing with a long main.lua transfer.
      await this.sendLine("press HOME", { silent: true });
      await delay(600);
      await this.ensurePrompt();

      const remoteDirectory = `/littlefs/apps/${app.slug}`;
      this.matchBuffer = "";
      await this.sendLine(`mkdir ${remoteDirectory}`);
      await this.waitFor("badge> ");

      for (let index = 0; index < files.length; index++) {
        const [path, bytes] = files[index];
        onProgress({ stage: "uploading", message: `Uploading ${path} (${index + 1}/${files.length})…`, app, path, index });
        await this.putFile(`${remoteDirectory}/${path}`, bytes, () => {
          onProgress({ stage: "uploading", message: `Retrying ${path} with a recovered badge console…`, app, path, index });
        });
      }

      onProgress({ stage: "reloading", message: "Refreshing badge launcher…", app });
      this.matchBuffer = "";
      await this.sendLine("reload");
      await this.waitFor("reload:", 8000);
      onProgress({ stage: "restarting", message: "Restarting the badge to apply app memory settings…", app });
      this.matchBuffer = "";
      await this.sendLine("reboot");
      try { await this.waitFor("badge> ", 12000); } catch {}
      onProgress({ stage: "complete", message: `${app.name} installed. Wait for the launcher, then open SolarPay.`, app });
      return app;
    } catch (error) {
      onProgress({ stage: "error", message: error.message, app });
      throw error;
    } finally {
      this.installing = false;
    }
  }
}
