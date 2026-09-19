import { EventEmitter } from "node:events";
import { approvalPacket, parsePacket } from "./protocol.js";

export class MockRadio extends EventEmitter {
  broadcast(packet) { parsePacket(packet); queueMicrotask(() => this.emit("packet", packet)); }
}

export class MockTerminalSerial extends EventEmitter {
  constructor(terminalBadgeId, radio) { super(); this.terminalBadgeId = terminalBadgeId; this.radio = radio; }
  readBadgeId() { return this.terminalBadgeId; }
  sendIntent(packet) { this.emit("terminal-status", "broadcasting"); this.radio.broadcast(packet); }
  relayApproval(packet) { this.emit("approval", parsePacket(packet)); }
  setResult(result) { this.emit("terminal-status", result); }
}

export class MockCustomerBadge extends EventEmitter {
  constructor(customerBadgeId, radio) {
    super(); this.customerBadgeId = customerBadgeId; this.radio = radio; this.pending = null;
    radio.on("packet", (packet) => {
      const parsed = parsePacket(packet);
      if (parsed.type === "intent") { this.pending = parsed; this.emit("display", parsed); }
    });
  }
  pressA() {
    if (!this.pending) throw new Error("No payment is displayed");
    const packet = approvalPacket({ intentId: this.pending.intentId, customerBadgeId: this.customerBadgeId, nonce: this.pending.nonce });
    this.pending = null;
    this.radio.broadcast(packet);
    return packet;
  }
}
