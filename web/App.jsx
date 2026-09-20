import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { gsap } from "gsap";
import QRCode from "qrcode";
import { request, savedApiKey } from "./api.js";
import { BadgeSerialClient, parseBadgeAppSource, webSerialSupported } from "./badge-serial.js";

const DEVNET_FAUCET_URL = "https://faucet.solana.com/";

const ROLES = [
  { id: "sender", name: "Sender", tagline: "Pay merchants with your badge" },
  { id: "merchant", name: "Merchant", tagline: "Accept badge payments" },
];

const SENDER_STEPS = ["Connect", "Install", "Ready to pay"];
const DEVICE_STEPS = ["Connect", "Install", "Ready"];
const USB_HINT = "Connects your physical SolarPay badge to this computer over USB";

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ glyphs */

function Logo() {
  return <svg className="logo" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2.5" y="5" width="19" height="14" rx="3.5" />
    <path d="M7 12h4.5" />
    <path d="M15.2 9.4a3.6 3.6 0 0 1 0 5.2M17.8 7.4a7 7 0 0 1 0 9.2" />
  </svg>;
}

function SenderGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2.5" y="6" width="13" height="12" rx="3" />
    <path d="M6 12h4" />
    <path d="M18.2 9.6a3.4 3.4 0 0 1 0 4.8M21 7.2a7 7 0 0 1 0 9.6" />
  </svg>;
}

function MerchantGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3.5 9.5h17v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    <path d="M3 9.5 5.2 4.4A1.5 1.5 0 0 1 6.6 3.5h10.8a1.5 1.5 0 0 1 1.4.9L21 9.5" />
    <path d="M9.5 14.5h5" />
  </svg>;
}

function BadgeGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2.5" y="5.5" width="15" height="13" rx="3" />
    <path d="M6 12h4" />
    <path d="M20.4 9.6a3.4 3.4 0 0 1 0 4.8" />
  </svg>;
}

function Chevron() {
  return <svg className="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9.5 6 5.5 6-5.5" /></svg>;
}

function Tick() {
  return <svg className="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
}

function Cross() {
  return <svg className="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>;
}

/* ------------------------------------------------------- signature: tap art */

/** The one memorable element: two badges and the radio between them.
 *  It carries state rather than decorating it — idle, listening, done. */
function TapArt({ mode }) {
  const root = useRef(null);
  const loop = useRef(null);

  useLayoutEffect(() => {
    const scope = root.current;
    if (!scope) return undefined;
    loop.current?.kill();
    loop.current = null;

    const rings = Array.from(scope.querySelectorAll(".art-ring"));
    const check = scope.querySelector(".art-check");
    gsap.killTweensOf(rings);
    if (check) gsap.killTweensOf(check);
    if (reduceMotion()) return undefined;

    if (mode === "listening") {
      const timeline = gsap.timeline({ repeat: -1 });
      rings.forEach((ring, index) => {
        timeline.fromTo(ring,
          { scale: 0.3, opacity: 0, transformOrigin: "left center" },
          { scale: 1, opacity: 1, duration: 1.4, ease: "power2.out" }, index * 0.42);
        timeline.to(ring, { opacity: 0, duration: 0.45, ease: "power1.in" }, index * 0.42 + 1.05);
      });
      loop.current = timeline;
    } else if (mode === "done") {
      if (check) {
        gsap.fromTo(check,
          { scale: 0.3, opacity: 0, transformOrigin: "50% 50%" },
          { scale: 1, opacity: 1, duration: 0.45, ease: "back.out(1.7)" });
      }
    } else {
      gsap.fromTo(rings,
        { scale: 0.65, opacity: 0, transformOrigin: "left center" },
        { scale: 1, opacity: 1, duration: 0.7, stagger: 0.07, ease: "power3.out" });
    }

    return () => { loop.current?.kill(); loop.current = null; };
  }, [mode]);

  return <div className={`art art-${mode}`} ref={root} aria-hidden="true">
    <svg viewBox="0 0 236 140">
      {mode === "done" ? (
        <g className="art-check">
          <circle cx="118" cy="70" r="32" />
          <path d="m103 70 11 11 19-22" />
        </g>
      ) : <>
        <rect className="art-badge" x="4" y="44" width="56" height="52" rx="11" />
        <rect className="art-chip" x="17" y="61" width="20" height="13" rx="3.5" />
        <g className="art-rings">
          <path className="art-ring" d="M72 54a24 24 0 0 1 0 32" />
          <path className="art-ring" d="M89 43a40 40 0 0 1 0 54" />
          <path className="art-ring" d="M106 32a56 56 0 0 1 0 76" />
        </g>
        <rect className="art-target" x="156" y="38" width="76" height="64" rx="14" />
      </>}
    </svg>
  </div>;
}

/* ------------------------------------------------------------ progress rail */

function StepRail({ steps, index, compact }) {
  const rail = useRef(null);
  const fill = useRef(null);
  const previous = useRef(index);

  useLayoutEffect(() => {
    const node = fill.current;
    if (!node) return undefined;
    const percent = steps.length > 1 ? (Math.min(index, steps.length - 1) / (steps.length - 1)) * 100 : 0;
    if (reduceMotion()) { gsap.set(node, { width: `${percent}%` }); previous.current = index; return undefined; }

    const timeline = gsap.timeline();
    timeline.to(node, { width: `${percent}%`, duration: 0.55, ease: "power2.inOut" }, 0);
    if (index > previous.current) {
      const marker = rail.current?.querySelectorAll(".rail-node")[Math.min(index, steps.length - 1)];
      if (marker) timeline.fromTo(marker, { scale: 0.7 }, { scale: 1, duration: 0.45, ease: "back.out(2.4)", clearProps: "transform" }, 0.2);
    }
    previous.current = index;
    return () => timeline.kill();
  }, [index, steps.length]);

  return <ol className={`rail ${compact ? "rail-compact" : ""}`} ref={rail}>
    <div className="rail-track"><i className="rail-fill" ref={fill} /></div>
    {steps.map((step, position) => <li
      key={step}
      className={position < index ? "done" : position === index ? "here" : ""}
      aria-current={position === index ? "step" : undefined}
    >
      <span className="rail-node">{position < index ? <Tick /> : position + 1}</span>
      <b>{step}</b>
    </li>)}
  </ol>;
}

/* ------------------------------------------------- popover open/close shell */

/** Shared behaviour for the header popovers: GSAP in/out, outside click,
 *  Escape, and focus return. Children render inside the animated panel. */
function Popover({ className, label, trigger, children, api }) {
  const [state, setState] = useState("closed"); // closed | open | closing
  const wrap = useRef(null);
  const panel = useRef(null);
  const button = useRef(null);
  const mounted = state !== "closed";

  const close = () => setState((current) => (current === "open" ? "closing" : current));

  /* Lets the page open this popover -- the merchant gate points at the badge
     control rather than duplicating its contents. */
  useEffect(() => {
    if (!api) return undefined;
    api.current = { open: () => setState("open") };
    return () => { api.current = null; };
  }, [api]);

  useLayoutEffect(() => {
    if (!panel.current) return undefined;
    const node = panel.current;

    if (state === "open") {
      const items = node.querySelectorAll("[data-stagger]");
      if (reduceMotion()) { gsap.set(node, { opacity: 1, y: 0, scale: 1 }); gsap.set(items, { opacity: 1, y: 0 }); return undefined; }
      const timeline = gsap.timeline({ defaults: { ease: "power3.out" } })
        .fromTo(node, { opacity: 0, y: -10, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.32 }, 0)
        .fromTo(items, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, stagger: 0.05, clearProps: "transform,opacity" }, 0.06);
      return () => { timeline.kill(); gsap.set(items, { clearProps: "all" }); };
    }

    if (state === "closing") {
      if (reduceMotion()) { setState("closed"); return undefined; }
      const tween = gsap.to(node, { opacity: 0, y: -8, scale: 0.98, duration: 0.18, ease: "power2.in", onComplete: () => setState("closed") });
      return () => tween.kill();
    }
    return undefined;
  }, [state]);

  useEffect(() => {
    if (state !== "open") return undefined;
    const onPointer = (event) => { if (!wrap.current?.contains(event.target)) close(); };
    const onKey = (event) => { if (event.key === "Escape") { close(); button.current?.focus(); } };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [state]);

  return <div className={`pop ${className || ""}`} ref={wrap}>
    {trigger({
      ref: button,
      open: state === "open",
      mounted,
      toggle: () => setState(mounted ? "closing" : "open"),
    })}
    {mounted && <div className="pop-panel" ref={panel} role="dialog" aria-label={label}>
      {children({ close, focusTrigger: () => button.current?.focus() })}
    </div>}
  </div>;
}

/* ------------------------------------------------------------ role selector */

function RoleSelect({ value, onChange }) {
  const active = ROLES.find((role) => role.id === value) || ROLES[0];

  return <Popover className="role-select" label="Choose how you are using SolarPay" trigger={({ ref, open, mounted, toggle }) => <button
    ref={ref}
    type="button"
    className={`role-trigger ${mounted ? "is-open" : ""}`}
    aria-haspopup="listbox"
    aria-expanded={open}
    onClick={toggle}
  >
    <span className="role-trigger-icon">{active.id === "sender" ? <SenderGlyph /> : <MerchantGlyph />}</span>
    <span className="role-trigger-text"><small>You are</small><b>{active.name}</b></span>
    <Chevron />
  </button>}>
    {({ close, focusTrigger }) => <div className="role-list" role="listbox" aria-label="Role">
      {ROLES.map((role, index) => <div key={role.id}>
        {index > 0 && <div className="role-or" data-stagger><i /><span>OR</span><i /></div>}
        <button
          type="button"
          role="option"
          data-stagger
          aria-selected={role.id === value}
          className={`role-option ${role.id === value ? "selected" : ""}`}
          onClick={() => { close(); focusTrigger(); if (role.id !== value) onChange(role.id); }}
        >
          <span className="role-option-icon">{role.id === "sender" ? <SenderGlyph /> : <MerchantGlyph />}</span>
          <span className="role-option-text"><b>{role.name}</b><small>{role.tagline}</small></span>
          {role.id === value && <span className="role-option-check"><Tick /></span>}
        </button>
      </div>)}
    </div>}
  </Popover>;
}

/* --------------------------------------------------------------------- app */

export function App() {
  const [network, setNetwork] = useState("CONNECTING");
  const [apiKey] = useState(savedApiKey());
  const [terminalBadgeId, setTerminalBadgeId] = useState("");
  const [customerBadgeId, setCustomerBadgeId] = useState("");
  const [amountSol, setAmountSol] = useState("0.01");
  const [memo, setMemo] = useState("Coffee");
  const [intent, setIntent] = useState(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [journey, setJourney] = useState("sender");
  const [badges, setBadges] = useState([]);
  const [setupMessage, setSetupMessage] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupStage, setSetupStage] = useState(0);
  const [syncedBadge, setSyncedBadge] = useState(null);
  const [balance, setBalance] = useState(null);
  const [qrCode, setQrCode] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [serialState, setSerialState] = useState("disconnected");
  const [serialMessage, setSerialMessage] = useState("Connect the badge to start listening.");
  const [serialLines, setSerialLines] = useState([]);
  const [proximity, setProximity] = useState(null);
  const [selectedLuaApp, setSelectedLuaApp] = useState(null);
  const [installStatus, setInstallStatus] = useState({ stage: "idle", message: "" });
  const [transactions, setTransactions] = useState([]);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [sheetNode, setSheetNode] = useState(null);
  const serialClient = useRef(null);
  const activeIntent = useRef(null);
  const settlementHandler = useRef(null);
  const settlementBusy = useRef(false);
  const setupAttempt = useRef(null);
  const serialLog = useRef(null);
  const luaFileInput = useRef(null);
  const appShell = useRef(null);
  const stage = useRef(null);
  const focusPanel = useRef(null);
  const checkoutDialog = useRef(null);
  const checkoutClosing = useRef(false);
  const deviceApi = useRef(null);

  /* ------------------------------------------------------------- animation */

  useLayoutEffect(() => {
    if (!appShell.current || reduceMotion()) return undefined;
    const targets = appShell.current.querySelectorAll(".topbar > *");
    const tween = gsap.fromTo(targets,
      { y: -12, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.5, stagger: 0.08, ease: "power3.out", clearProps: "transform,opacity" });
    return () => { tween.kill(); gsap.set(targets, { clearProps: "all" }); };
  }, []);

  useLayoutEffect(() => {
    if (!stage.current || reduceMotion()) return undefined;
    const targets = stage.current.querySelectorAll(":scope > *");
    const tween = gsap.fromTo(targets,
      { y: 16, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.5, stagger: 0.06, ease: "power3.out", clearProps: "transform,opacity" });
    return () => { tween.kill(); gsap.set(targets, { clearProps: "all" }); };
  }, [journey]);

  /* The workspace itself becomes the payment request. */
  const requestActive = journey === "merchant" && (busy || Boolean(intent) || Boolean(error));

  /* The panel enters once per activation; each state change then restages the
     lines inside it. Every cleanup strips its own inline styles, so an
     interrupted tween can never strand content at zero opacity. */
  useLayoutEffect(() => {
    const node = focusPanel.current;
    if (!requestActive || !node || reduceMotion()) return undefined;
    const tween = gsap.fromTo(node,
      { y: 24, scale: 0.96, opacity: 0 },
      { y: 0, scale: 1, opacity: 1, duration: 0.55, ease: "power3.out", clearProps: "all" });
    return () => { tween.kill(); gsap.set(node, { clearProps: "all" }); };
  }, [requestActive]);

  useLayoutEffect(() => {
    const node = focusPanel.current;
    if (!requestActive || !node || reduceMotion()) return undefined;
    const lines = node.querySelectorAll(".focus-item, .focus-amount, .focus-hint, .focus-actions");
    const timeline = gsap.timeline({ defaults: { ease: "power3.out" } })
      .fromTo(lines, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.42, stagger: 0.07, clearProps: "all" }, 0.1);
    if (step === 5) {
      timeline.fromTo(node.querySelector(".focus-amount"),
        { scale: 0.93 }, { scale: 1, duration: 0.6, ease: "back.out(1.9)", clearProps: "all" }, 0.25);
    }
    return () => { timeline.kill(); gsap.set(lines, { clearProps: "all" }); };
  }, [requestActive, step, error]);

  /* Radix mounts the portal a commit late, so the sheet animation is keyed on
     the node arriving rather than on the open flag. The ref callback is stable
     so a keystroke in the form never replays the entrance. */
  const attachSheet = useCallback((node) => { checkoutDialog.current = node; setSheetNode(node); }, []);

  useLayoutEffect(() => {
    if (!sheetNode) return undefined;
    gsap.set(sheetNode, { xPercent: -50, yPercent: -50 });
    if (reduceMotion()) return undefined;
    const lines = sheetNode.querySelectorAll(".sheet-head, .field, .sheet-actions, .sheet-note");
    const timeline = gsap.timeline({ defaults: { ease: "power3.out" } })
      .fromTo(".sheet-backdrop", { opacity: 0 }, { opacity: 1, duration: 0.22 }, 0)
      .fromTo(sheetNode,
        { xPercent: -50, yPercent: -50, y: 24, scale: 0.95, opacity: 0 },
        { xPercent: -50, yPercent: -50, y: 0, scale: 1, opacity: 1, duration: 0.44, ease: "back.out(1.4)" }, 0)
      .fromTo(lines, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.34, stagger: 0.06, clearProps: "all" }, 0.14);
    return () => { timeline.kill(); gsap.set(lines, { clearProps: "all" }); };
  }, [sheetNode]);

  function animateDisclosure(event) {
    if (!event.currentTarget.open || reduceMotion()) return;
    const content = event.currentTarget.querySelector(".drawer-body");
    if (content) gsap.fromTo(content, { y: -8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: "power2.out", clearProps: "transform,opacity" });
  }

  /* ------------------------------------------------------------- lifecycle */

  useEffect(() => {
    const client = new BadgeSerialClient();
    serialClient.current = client;
    const onStatus = ({ detail }) => {
      setSerialState(detail.state);
      setSerialMessage(detail.message);
      if (detail.state === "disconnected") clearConnectedUser();
    };
    const onLine = ({ detail }) => {
      setSerialLines((current) => [...current.slice(-299), { ...detail, at: new Date().toLocaleTimeString() }]);
      if (detail.kind === "event" && detail.event === "proximity") {
        setProximity({ zone: detail.fields.zone, rssi: Number(detail.fields.rssi), peer: detail.fields.peer });
      } else if (detail.kind === "event" && detail.event === "proximity_lost") {
        setProximity(null);
      } else if (detail.kind === "event" && detail.event === "approval_received") {
        void settlementHandler.current?.(detail.fields);
      }
    };
    client.addEventListener("status", onStatus);
    client.addEventListener("line", onLine);
    return () => {
      client.removeEventListener("status", onStatus);
      client.removeEventListener("line", onLine);
      if (serialClient.current === client) serialClient.current = null;
      void client.disconnect();
    };
  }, []);

  useEffect(() => {
    if (serialLog.current) serialLog.current.scrollTop = serialLog.current.scrollHeight;
  }, [serialLines]);

  useEffect(() => {
    if (serialState !== "connected") return undefined;
    const heartbeat = () => {
      const client = serialClient.current;
      if (client?.writer && !client.installing) void client.sendLine("press AUX1", { silent: true }).catch(() => {});
    };
    heartbeat();
    const timer = setInterval(heartbeat, 30000);
    return () => clearInterval(timer);
  }, [serialState]);

  useEffect(() => {
    const timer = setInterval(() => setRemaining(intent ? Math.max(0, Math.ceil((intent.expiresAt - Date.now()) / 1000)) : 0), 250);
    return () => clearInterval(timer);
  }, [intent]);

  useEffect(() => {
    if (!intent || step !== 2 || Date.now() < intent.expiresAt) return;
    activeIntent.current = null;
    setError("Payment request expired. Start a new checkout.");
  }, [intent, remaining, step]);

  useEffect(() => {
    fetch("/api/health").then((response) => response.json()).then((health) => setNetwork(String(health.solanaMode || "unknown").toUpperCase())).catch(() => setNetwork("OFFLINE"));
    loadBadges();
    loadTransactions();
  }, []);

  /* ---------------------------------------------------------------- actions */

  async function loadBadges() {
    try {
      const loaded = (await request("/badges", {}, apiKey)).badges;
      setBadges(loaded);
    }
    catch (reason) { setSetupMessage(reason.message); }
  }

  function clearConnectedUser() {
    setSyncedBadge(null);
    setBalance(null);
    setQrCode("");
    setTerminalBadgeId("");
    setCustomerBadgeId("");
    setProximity(null);
    setupAttempt.current = null;
  }

  async function loadTransactions() {
    try { setTransactions((await request("/transactions", {}, apiKey)).transactions); }
    catch (reason) { setError(reason.message); }
  }

  async function setupBadge(role) {
    setSetupBusy(true); setSetupMessage(""); setSetupStage(Math.max(setupStage, 1));
    try {
      const client = await connectSerialClient();
      await client.ensureReady();
      const badgeIdentity = await client.readBadgeIdentity();
      let created = setupAttempt.current;
      if (!created || created.role !== role || created.badgeId !== badgeIdentity.badgeId) {
        created = await request("/badges", { method: "POST", body: JSON.stringify({ role, badgeId: badgeIdentity.badgeId }) }, apiKey);
        setupAttempt.current = created;
      }
      setSetupStage(2);
      setTerminalBadgeId(created.badgeId); setCustomerBadgeId(created.badgeId);
      await loadBadges();
      const universalBadge = { badgeId: created.badgeId, role: created.role, roles: ["customer", "merchant"], solanaAddress: created.publicKey };
      await syncBadge(universalBadge);
      await installSolarPayForBadge(universalBadge);
      setupAttempt.current = null;
      setSetupStage(3);
      const funded = created.funding?.status === "confirmed" ? ` Funded with ${(created.funding.lamports / 1e9).toLocaleString()} SOL.`
        : created.funding?.status === "failed" ? " Automated funding failed — use the faucet link below, then refresh." : "";
      setSetupMessage(`Sender and Merchant are installed on one wallet.${funded}`);
    } catch (reason) {
      if (reason?.name === "NotFoundError") {
        setSerialState("disconnected");
        setSerialMessage("Device selection was cancelled.");
        setSetupMessage("Device selection was cancelled. Try connecting again.");
      } else {
        setSetupMessage(reason.message);
      }
      setSetupStage(0);
    }
    finally { setSetupBusy(false); }
  }

  async function toggleSerial() {
    const client = serialClient.current;
    if (!client) return;
    if (serialState === "connected") {
      await client.disconnect();
      setSetupStage(0);
      setSetupMessage("Badge disconnected.");
      return;
    }
    setError("");
    try {
      const info = await client.connect();
      const vid = info.usbVendorId?.toString(16).padStart(4, "0") || "unknown";
      const pid = info.usbProductId?.toString(16).padStart(4, "0") || "unknown";
      setSerialMessage(`USB ${vid}:${pid} · listening at 115200 baud`);
    } catch (reason) {
      if (reason?.name === "NotFoundError") {
        setSerialState("disconnected");
        setSerialMessage("Device selection was cancelled.");
      } else {
        setSerialState("error");
        setSerialMessage(reason.message || "Could not open the badge serial port.");
      }
    }
  }

  async function connectSerialClient() {
    const client = serialClient.current;
    if (!client) throw new Error("Serial client is not ready.");
    if (client.port) return client;
    const info = await client.connect();
    const vid = info.usbVendorId?.toString(16).padStart(4, "0") || "unknown";
    const pid = info.usbProductId?.toString(16).padStart(4, "0") || "unknown";
    setSerialMessage(`USB ${vid}:${pid} · listening at 115200 baud`);
    return client;
  }

  async function chooseLuaApp(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > 128 * 1024) throw new Error("Choose a Lua app smaller than 128 KiB.");
      const source = await file.text();
      const app = parseBadgeAppSource(source);
      setSelectedLuaApp({ ...app, source, filename: file.name });
      setInstallStatus({ stage: "ready", message: `${app.name} is ready to install. The same slug will be overwritten.` });
    } catch (reason) {
      setSelectedLuaApp(null);
      setInstallStatus({ stage: "error", message: reason.message });
    }
  }

  async function installLuaSource(source) {
    const app = parseBadgeAppSource(source);
    setInstallStatus({ stage: "connecting", message: `Connecting to install ${app.name}…` });
    try {
      const client = await connectSerialClient();
      await client.installApp(source, ({ stage: phase, message }) => setInstallStatus({ stage: phase, message }));
    } catch (reason) {
      if (reason?.name === "NotFoundError") setInstallStatus({ stage: "error", message: "Device selection was cancelled." });
      else setInstallStatus({ stage: "error", message: reason.message || "Badge app installation failed." });
    }
  }

  async function installSolarPay() {
    setInstallStatus({ stage: "connecting", message: "Connecting to install SolarPay…" });
    try {
      await connectSerialClient();
      if (syncedBadge) await installSolarPayForBadge(syncedBadge);
      else {
        for (const [index, role] of ["customer", "merchant"].entries()) {
          const response = await fetch(`/api/badge-apps/solarpay-bundle?role=${role}`);
          if (!response.ok) throw new Error("Could not load the SolarPay badge apps.");
          const bundle = await response.json();
          const files = bundle.files.map((file) => ({
            path: file.path,
            bytes: Uint8Array.from(atob(file.data), (character) => character.charCodeAt(0)),
          }));
          await serialClient.current.installApp(bundle.source, ({ stage: phase, message }) => setInstallStatus({
            stage: phase,
            message: `App ${index + 1}/2 · ${message}`,
          }), files);
        }
      }
    } catch (reason) {
      if (reason?.name === "NotFoundError") setInstallStatus({ stage: "error", message: "Device selection was cancelled." });
      else setInstallStatus({ stage: "error", message: reason.message || "SolarPay installation failed." });
    }
  }

  // The native firmware is already on the badge; there are no Lua apps to
  // install. What the badge still needs from the laptop is its wallet and
  // balance, which it keeps in NVS so the sender shows them on battery.
  async function installSolarPayForBadge(badge) {
    setInstallStatus({ stage: "provision", message: "Provisioning wallet on the badge…" });
    try {
      const info = await request(`/badges/${badge.badgeId}/balance`, {}, apiKey);
      const lamports = info.lamports ?? Math.round((info.sol || 0) * 1e9);
      await serialClient.current.provisionWallet(badge.solanaAddress, lamports);
      setInstallStatus({ stage: "done", message: "Badge provisioned." });
    } catch (reason) {
      setInstallStatus({ stage: "error", message: reason.message });
      throw reason;
    }
  }

  async function syncBadge(badge) {
    setSyncedBadge(badge); setBalance(null); setQrCode(""); setSyncBusy(true); setSetupMessage("");
    try {
      const info = await request(`/badges/${badge.badgeId}/balance`, {}, apiKey);
      setBalance(info);
      try {
        const lamports = info.lamports ?? Math.round((info.sol || 0) * 1e9);
        await serialClient.current?.provisionWallet(badge.solanaAddress, lamports);
      } catch { /* the badge may not be on USB; the stored value stands */ }
      if (badge.role === "customer" || badge.roles?.includes("customer")) setQrCode(await QRCode.toDataURL(`solana:${badge.solanaAddress}`, { width: 260, margin: 1, color: { dark: "#16141c", light: "#ffffff" } }));
    } catch (reason) { setSetupMessage(reason.message); }
    finally { setSyncBusy(false); }
  }

  // A balance read that leaves the connected-badge panel alone. syncBadge() owns
  // syncedBadge, balance and qrCode; calling it for the payer would swap the
  // header wallet over to the sender's.
  async function readBadgeLamports(badgeId) {
    if (!badgeId) return null;
    try {
      const info = await request(`/badges/${badgeId}/balance`, {}, apiKey);
      return info.lamports ?? Math.round((info.sol || 0) * 1e9);
    } catch { return null; }
  }

  async function fundSender() {
    if (!syncedBadge || !(syncedBadge.role === "customer" || syncedBadge.roles?.includes("customer"))) return;
    setSyncBusy(true); setSetupMessage("");
    try {
      const result = await request(`/badges/${syncedBadge.badgeId}/airdrop`, { method: "POST" }, apiKey);
      setBalance({ ...result, solanaAddress: syncedBadge.solanaAddress, role: "customer" });
      setSetupMessage(`Faucet confirmed ${(result.funding.lamports / 1e9).toLocaleString()} SOL.`);
    } catch (reason) { setSetupMessage(`Faucet request failed: ${reason.message}`); }
    finally { setSyncBusy(false); }
  }

  async function refreshBalance() {
    if (!syncedBadge) return;
    await syncBadge(syncedBadge);
  }

  const lamports = useMemo(() => Math.round(Number(amountSol) * 1_000_000_000), [amountSol]);

  async function createPayment() {
    setBusy(true); setError(""); setIntent(null); activeIntent.current = null;
    try {
      if (serialState !== "connected" || !serialClient.current?.writer) throw new Error("Connect the merchant badge before starting checkout.");
      const created = await request("/intents", { method: "POST", body: JSON.stringify({ terminalBadgeId, amountLamports: lamports, memo }) }, apiKey);
      setIntent(created); activeIntent.current = created; setStep(1);
      await serialClient.current.pushCheckout(`${created.radioPacket}\n${created.radioItemPacket}\n`);
      setStep(2);
    } catch (reason) { setError(reason.message); setStep(0); }
    finally { setBusy(false); }
  }

  async function settleBadgeApproval(fields) {
    const current = activeIntent.current;
    if (!current || fields.intent !== current.id || settlementBusy.current) return;
    settlementBusy.current = true;
    setBusy(true); setError(""); setStep(3);
    try {
      const approval = await request(`/intents/${current.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ customerBadgeId: fields.customer_badge_id, intentNonce: fields.nonce }),
      }, apiKey);
      setStep(4);
      const submitted = await request(`/intents/${current.id}/submit`, { method: "POST", body: JSON.stringify({ signedTransaction: approval.signedTransaction }) }, apiKey);
      setIntent(submitted.intent); activeIntent.current = submitted.intent; setStep(5);
      await loadTransactions();
      // The merchant badge knows its own balance and nothing about the payer's,
      // so the authoritative figure rides along with the confirmation and the
      // merchant relays it to the sender over the still-open radio link.
      const payerLamports = await readBadgeLamports(fields.customer_badge_id);
      try {
        // Pass the Solana signature through so the badge can show the
        // transaction and print its devnet explorer URL.
        const balancePart = payerLamports === null ? "" : ` ${payerLamports}`;
        await serialClient.current?.pushCheckout(`SP1:C:${current.id} ${submitted.intent?.signature || ""}${balancePart}\n`);
      } catch (receiptError) {
        setSerialMessage(`Payment confirmed, but the badge receipt update failed: ${receiptError.message}`);
      }
      const merchant = badges.find((badge) => badge.badgeId === current.terminalBadgeId);
      if (merchant) void syncBadge(merchant);
      // Both sides moved, so the badge list behind the wallet panel is stale too.
      void loadBadges();
    } catch (reason) {
      setError(reason.message);
      try { await serialClient.current?.pushCheckout(`SP1:E:${current.id}\n`); } catch {}
    }
    finally { setBusy(false); settlementBusy.current = false; }
  }

  settlementHandler.current = settleBadgeApproval;

  function reset() { setIntent(null); activeIntent.current = null; setError(""); setStep(0); }

  async function cancelPayment() {
    const current = activeIntent.current;
    if (!current || step > 2) return;
    setBusy(true);
    setError("");
    try {
      await request(`/intents/${current.id}/cancel`, { method: "POST" }, apiKey);
      activeIntent.current = null;
      try {
        await serialClient.current?.pushCheckout(`SP1:E:${current.id}\n`);
      } catch (reason) {
        setSerialMessage(`Payment cancelled, but the badge update failed: ${reason.message}`);
      }
      reset();
      await loadTransactions();
    } catch (reason) {
      setError(reason.message || "The payment could not be cancelled.");
    } finally {
      setBusy(false);
    }
  }

  /* ----------------------------------------------------------- derived view */

  const badgeReady = Boolean(syncedBadge) && setupStage >= 3;
  const deviceIndex = badgeReady ? 2 : setupStage >= 2 ? 1 : 0;
  const connected = serialState === "connected";
  const canRequest = connected && Boolean(terminalBadgeId);
  const paymentCanCancel = Boolean(activeIntent.current && intent && step <= 2);
  const serialSupported = webSerialSupported();
  const isSender = syncedBadge?.role === "customer" || syncedBadge?.roles?.includes("customer");
  const liveAmount = intent?.amountLamports ? intent.amountLamports / 1e9 : Number(amountSol) || 0;

  // One tone per state: amber preparing, purple waiting, green paid, red stopped.
  const tone = error ? "stop" : step === 5 ? "ok" : step >= 2 ? "wait" : "pend";
  const toneLabel = error ? "Cancelled"
    : step === 5 ? "Payment received"
      : step === 2 ? "Waiting for badge"
        : step === 3 ? "Signing"
          : step === 4 ? "Submitting" : "Preparing request";
  const artMode = requestActive
    ? (error ? "idle" : step === 5 ? "done" : step >= 1 ? "listening" : "idle")
    : "idle";

  // Both role apps are installed on the one badge; which to open follows the
  // role selected in the header. Names match the manifests in badges/.
  const badgeAppName = journey === "merchant" ? "SolarPay Merchant" : "SolarPay Sender";

  const connectLabel = !serialSupported ? "Web Serial not supported"
    : setupBusy && setupStage >= 2 ? "Installing SolarPay…"
      : setupBusy ? "Connecting…" : "Connect badge";

  function switchRole(next) {
    setJourney(next);
    setSetupMessage("");
  }

  /* --------------------------------------------------------- checkout sheet */

  function openCheckout() {
    checkoutClosing.current = false;
    setCheckoutOpen(true);
  }

  /** Dismiss settles back down; confirm lifts away so the workspace takes over. */
  function closeCheckout(mode, after) {
    if (checkoutClosing.current) return;
    const node = checkoutDialog.current;
    const finish = () => { checkoutClosing.current = false; setCheckoutOpen(false); after?.(); };
    if (!node || reduceMotion()) { finish(); return; }
    checkoutClosing.current = true;
    const lift = mode === "confirm";
    gsap.timeline({ onComplete: finish })
      .to(node, {
        xPercent: -50, yPercent: -50,
        y: lift ? -18 : 12, scale: lift ? 1.05 : 0.97, opacity: 0,
        duration: lift ? 0.3 : 0.2, ease: lift ? "power2.in" : "power2.inOut",
      }, 0)
      .to(".sheet-backdrop", { opacity: 0, duration: lift ? 0.3 : 0.2, ease: "power1.in" }, 0);
  }

  function submitCheckout(event) {
    event.preventDefault();
    if (!canRequest) return;
    closeCheckout("confirm", () => void createPayment());
  }

  /* ------------------------------------------------- persistent badge control */

  const badgeControl = <Popover className="device" label="Badge device" api={deviceApi} trigger={({ ref, open, mounted, toggle }) => <button
    ref={ref}
    type="button"
    title={USB_HINT}
    className={`device-trigger ${badgeReady ? "is-ready" : ""} ${mounted ? "is-open" : ""}`}
    aria-haspopup="dialog"
    aria-expanded={open}
    onClick={toggle}
  >
    <span className="device-trigger-icon"><BadgeGlyph /></span>
    {badgeReady
      ? <span className="device-trigger-text">Badge</span>
      : connected
        ? <span className="device-trigger-text">Badge<i>•</i><b>Setting up</b></span>
        : <span className="device-trigger-text">Connect badge</span>}
    <Chevron />
  </button>}>
    {() => <div className="device-panel">
      {!badgeReady && <p className="device-hint" data-stagger>{USB_HINT}.</p>}

      {!badgeReady && <div className="device-status" data-stagger>
        <span className={`dot dot-${serialState}`} />
        <div>
          <b>{badgeReady ? "Ready" : connected ? "Setting up" : "No badge connected"}</b>
          <p>{serialMessage}</p>
          {proximity && <p>{proximity.zone.replace("_", " ")} · {proximity.rssi} dBm</p>}
        </div>
      </div>}

      {/* The rail explains a setup that is still in progress. Once the badge is
          ready it only competes with the one thing left to do, which happens on
          the badge itself -- there is no console command that launches an app. */}
      {!badgeReady && <div data-stagger><StepRail steps={DEVICE_STEPS} index={deviceIndex} compact /></div>}

      <div className="device-actions" data-stagger>
        {!badgeReady
          ? <button className="cta cta-small" onClick={() => setupBadge(journey === "sender" ? "customer" : "merchant")} disabled={setupBusy || !serialSupported}>
            {serialSupported && !setupBusy ? "Connect badge over USB" : connectLabel}
          </button>
          : <div className="device-next">
            <b>Open {badgeAppName} on the badge</b>
            <p>Pick it from the badge launcher. This laptop stays connected and listens for the tap.</p>
          </div>}
      </div>

      {syncedBadge && <div className="device-wallet" data-stagger>
        <small>Wallet</small>
        <b>{syncedBadge.badgeId}</b>
        <code>{syncedBadge.solanaAddress}</code>
        <div className="device-wallet-row">
          <span>{syncBusy || !balance ? "—" : `${balance.sol.toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL`}</span>
          <button className="link" onClick={refreshBalance} disabled={syncBusy}>Refresh</button>
          {balance?.explorerUrl && <a href={balance.explorerUrl} target="_blank" rel="noreferrer">Explorer ↗</a>}
        </div>
      </div>}

      {setupMessage && <p className="note" data-stagger>{setupMessage}</p>}
      {!serialSupported && <p className="note" data-stagger>Open SolarPay in Chrome or Edge on a desktop to connect a badge over USB.</p>}

      {connected && <div className="device-disconnect" data-stagger>
        <button className="link" onClick={toggleSerial}>Disconnect badge</button>
      </div>}

      <details className="drawer drawer-flush" onToggle={animateDisclosure} data-stagger>
        <summary>Advanced device tools</summary>
        <div className="drawer-body">
          <input ref={luaFileInput} type="file" accept=".lua,text/plain" hidden onChange={chooseLuaApp} />
          <div className="tool-row">
            <button className="ghost" onClick={() => luaFileInput.current?.click()}>Choose Lua app</button>
            {selectedLuaApp && <button className="ghost" onClick={() => installLuaSource(selectedLuaApp.source)}>Install {selectedLuaApp.name}</button>}
            <button className="ghost" onClick={installSolarPay}>Reinstall SolarPay</button>
            <button className="ghost" onClick={() => setSerialLines([])} disabled={!serialLines.length}>Clear log</button>
          </div>
          {installStatus.message && <p className={`note note-${installStatus.stage}`}>{installStatus.message}</p>}
          {isSender && network !== "MOCK" && <p className="note">Automatic airdrop unavailable? Fund this wallet with the <a href={DEVNET_FAUCET_URL} target="_blank" rel="noreferrer">Solana faucet ↗</a>, then refresh.</p>}
          <div className="serial" ref={serialLog} role="log" aria-live="off" aria-label="Badge serial output">
            {serialLines.length === 0
              ? <span className="empty">No serial output yet.</span>
              : serialLines.map((line, index) => <div className={`serial-line ${line.kind}`} key={`${line.at}-${index}`}>
                <time>{line.at}</time><span>{line.kind === "event" ? line.event : line.kind}</span><code>{line.text}</code>
              </div>)}
          </div>
        </div>
      </details>
    </div>}
  </Popover>;

  /* ------------------------------------------------------------------ render */

  return <main className="shell" ref={appShell}>
    <header className="topbar">
      <div className="brand"><Logo /><span>SolarPay</span></div>
      <div className="topbar-right">
        {badgeControl}
        <RoleSelect value={journey} onChange={switchRole} />
      </div>
    </header>

    <div className="shell-body">
    <section className="stage" ref={stage} key={journey}>
      {journey === "sender" && <>
        <h1>Send money<br />with a tap.</h1>
        <p className="lede">{badgeReady
          ? "Hold your badge near a checkout, then confirm on the badge to pay."
          : "Connect your badge from the top right. It gets a wallet you can spend from."}</p>
        <TapArt mode={artMode} />
        <StepRail steps={SENDER_STEPS} index={deviceIndex} />

        {badgeReady && <div className="ready">
          <div className="ready-head"><span className="pill pill-ok"><i />Connected</span><code>{syncedBadge.badgeId}</code></div>
          <code className="wallet-address">{syncedBadge.solanaAddress}</code>
          <div className="wallet">
            <div className="wallet-balance">
              <small>Balance</small>
              <strong>{syncBusy || !balance ? "—" : `${balance.sol.toLocaleString(undefined, { maximumFractionDigits: 9 })}`}<em>SOL</em></strong>
            </div>
            {qrCode && <figure className="wallet-qr">
              <img src={qrCode} alt={`Wallet address QR code for ${syncedBadge.badgeId}`} />
              <figcaption>Top up</figcaption>
            </figure>}
          </div>
          <div className="ready-actions">
            <button className="ghost" onClick={fundSender} disabled={syncBusy}>{syncBusy ? "Requesting…" : "Add test SOL"}</button>
            <button className="link" onClick={refreshBalance} disabled={syncBusy}>Refresh</button>
          </div>
          {network !== "MOCK" && <p className="note note-faucet">Airdrop not landing? Fund this wallet with the <a href={DEVNET_FAUCET_URL} target="_blank" rel="noreferrer">Solana faucet ↗</a>, then refresh.</p>}
        </div>}

        {setupMessage && <p className="note">{setupMessage}</p>}
        {!serialSupported && <p className="note">Open SolarPay in Chrome or Edge on a desktop to connect a badge over USB.</p>}
      </>}

      {journey === "merchant" && !requestActive && <>
        <h1>Take a payment.</h1>
        <p className="lede">{badgeReady
          ? "Name the item, set the price, and wait for a badge to tap."
          : "Connect your merchant badge to start taking payments."}</p>

        <TapArt mode={artMode} />
        <StepRail steps={DEVICE_STEPS} index={deviceIndex} />

        {badgeReady && <div className="ready">
          <div className="ready-head"><span className="pill pill-ok"><i />Connected</span><code>{syncedBadge.badgeId}</code></div>
          <div className="wallet">
            <div className="wallet-balance">
              <small>Balance</small>
              <strong>{syncBusy || !balance ? "—" : `${balance.sol.toLocaleString(undefined, { maximumFractionDigits: 9 })}`}<em>SOL</em></strong>
            </div>
          </div>
          <div className="ready-actions">
            <button className="link" onClick={refreshBalance} disabled={syncBusy}>Refresh</button>
          </div>
        </div>}

        {/* Checkout needs terminalBadgeId, which only a finished setup provides.
            Gating the entry point means the form can never be filled in for a
            request that could not be sent. */}
        {badgeReady
          ? <button className="invite" onClick={openCheckout}>
            <span className="invite-plus" aria-hidden="true">+</span>
            <span className="invite-text"><b>New payment request</b><small>Item and amount</small></span>
            <span className="invite-go" aria-hidden="true">→</span>
          </button>
          : <button className="invite invite-connect" onClick={() => deviceApi.current?.open()}>
            <span className="invite-plus" aria-hidden="true"><BadgeGlyph /></span>
            <span className="invite-text"><b>Connect your badge</b><small>Required to take payments</small></span>
            <span className="invite-go" aria-hidden="true">→</span>
          </button>}
      </>}

      {journey === "merchant" && requestActive && <div className={`kiosk kiosk-${tone}`} ref={focusPanel} aria-live="polite">
        <div className="kiosk-icon">{tone === "ok" ? <Tick /> : tone === "stop" ? <Cross /> : <BadgeGlyph />}</div>
        <h2 className="kiosk-title">{toneLabel}</h2>
        <p className="focus-item">{memo || "Payment"}</p>
        <p className="focus-amount">{liveAmount.toLocaleString(undefined, { maximumFractionDigits: 9 })}<em>SOL</em></p>

        {tone !== "ok" && tone !== "stop" && <div className="kiosk-motion"><TapArt mode={artMode} /></div>}

        <div className="focus-hint">
          {!error && step === 2 && <p>Hold the sender badge near this terminal. <b>{remaining}s</b> left.</p>}
          {!error && step < 2 && <p>Sending the request to your badge.</p>}
          {!error && step > 2 && step < 5 && <p>Signing and submitting on {network}.</p>}
          {!error && step === 5 && intent && <>
            <p>Confirmed on {network}.</p>
            <code>{intent.signature}</code>
            {intent.explorerUrl && <a href={intent.explorerUrl} target="_blank" rel="noreferrer">View on Solana Explorer ↗</a>}
          </>}
          {error && <p>{error} Nothing was charged.</p>}
        </div>

        <div className="focus-actions">
          {step === 5 || (error && !paymentCanCancel)
            ? <button className="cta" onClick={() => { reset(); if (step === 5) openCheckout(); }}>{step === 5 ? "New payment request" : "Back"}</button>
            : <button className="ghost" onClick={cancelPayment} disabled={busy || !paymentCanCancel}>{busy && intent ? "Cancelling…" : error ? "Try cancelling again" : "Cancel payment"}</button>}
        </div>
      </div>}
    </section>

    {journey === "merchant" && !requestActive && <section className="drawers">
      <details className="drawer" onToggle={animateDisclosure}>
        <summary>Recent payments<span>{transactions.length ? `${transactions.length} total` : "None yet"}</span></summary>
        <div className="drawer-body">
          <button className="link" onClick={loadTransactions}>Refresh</button>
          {transactions.length === 0
            ? <p className="empty">No payments yet.</p>
            : <ul className="ledger">{transactions.map((transaction) => <li key={transaction.id}>
              <i className={`dot dot-${transaction.status}`} />
              <div><b>{transaction.memo || "Payment"}</b><small>{transaction.customerBadgeId ? `${transaction.customerBadgeId} → ${transaction.terminalBadgeId}` : transaction.terminalBadgeId}</small></div>
              <strong>{(transaction.amountLamports / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL</strong>
              {transaction.explorerUrl ? <a href={transaction.explorerUrl} target="_blank" rel="noreferrer">Explorer ↗</a> : <span className="muted">{transaction.status}</span>}
            </li>)}</ul>}
        </div>
      </details>
    </section>}

    <footer className="foot">Wallet keys stay encrypted on this computer.</footer>
    </div>

    <Dialog.Root open={checkoutOpen} onOpenChange={(open) => { if (!open) closeCheckout("dismiss"); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-backdrop" />
        <Dialog.Content className="sheet" ref={attachSheet} aria-describedby={undefined}>
          <Dialog.Close asChild>
            <button className="sheet-close" aria-label="Close"><X size={18} strokeWidth={2} /></button>
          </Dialog.Close>

          <div className="sheet-head">
            <span className="sheet-mark" aria-hidden="true">+</span>
            <Dialog.Title>New payment request</Dialog.Title>
          </div>

          <form onSubmit={submitCheckout}>
            <div className="field">
              <label htmlFor="sheet-item">Item</label>
              <input id="sheet-item" value={memo} onChange={(event) => setMemo(event.target.value)} maxLength={64} placeholder="Coffee" required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="sheet-amount">Amount</label>
              <div className="amount">
                <span>◎</span>
                <input id="sheet-amount" type="number" min="0.000000001" step="0.000000001" value={amountSol} onChange={(event) => setAmountSol(event.target.value)} required />
                <b>SOL</b>
              </div>
            </div>
            <div className="sheet-actions">
              <button type="submit" className="cta" disabled={!canRequest}>Request payment</button>
            </div>
            {!canRequest && <p className="sheet-note">Connect a badge to request payment.</p>}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </main>;
}
