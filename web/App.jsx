import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { gsap } from "gsap";
import QRCode from "qrcode";
import { request, savedApiKey } from "./api.js";
import { BadgeSerialClient, parseBadgeAppSource, webSerialSupported } from "./badge-serial.js";

const STEPS = ["Ready", "Broadcasting", "Awaiting approval", "Signing", "Submitting", "Confirmed"];
const DEVNET_FAUCET_URL = "https://faucet.solana.com/";

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
  const [setupOpen, setSetupOpen] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const serialClient = useRef(null);
  const activeIntent = useRef(null);
  const settlementHandler = useRef(null);
  const settlementBusy = useRef(false);
  const setupAttempt = useRef(null);
  const serialLog = useRef(null);
  const luaFileInput = useRef(null);
  const appShell = useRef(null);
  const paymentPanel = useRef(null);
  const paymentState = useRef(null);
  const previousStep = useRef(0);

  useLayoutEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return undefined;

    const context = gsap.context(() => {
      const timeline = gsap.timeline({ defaults: { ease: "power3.out" } });
      timeline
        .from(".topbar > *", { y: -10, opacity: 0, duration: 0.45, stagger: 0.06, clearProps: "transform,opacity" });
    }, appShell);

    return () => context.revert();
  }, []);

  useLayoutEffect(() => {
    if (!appShell.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const context = gsap.context(() => {
      const targets = appShell.current.querySelectorAll(".hero > *, .setup-intro, .device-layout, .payment-panel, .transactions-panel");
      gsap.fromTo(
        targets,
        { y: 10, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.42, stagger: 0.045, ease: "power2.out", clearProps: "transform,opacity" },
      );
    }, appShell);
    return () => context.revert();
  }, [journey]);

  useLayoutEffect(() => {
    if (!paymentPanel.current || (!busy && !intent && !error)) return undefined;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (busy && !intent) {
      paymentPanel.current.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    }
    if (reduceMotion) return undefined;

    const context = gsap.context(() => {
      const timeline = gsap.timeline();
      timeline
        .fromTo(paymentPanel.current, { boxShadow: "0 0 0 0 rgba(118, 87, 232, 0)" }, {
          boxShadow: "0 0 0 4px rgba(118, 87, 232, .12)", duration: 0.28, ease: "power2.out",
        })
        .to(paymentPanel.current, { boxShadow: "0 0 0 1px rgba(118, 87, 232, .08)", duration: 0.7, ease: "power2.out" });
      const backdrop = document.querySelector(".payment-backdrop");
      if (backdrop) gsap.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.2, ease: "power1.out" });
      if (paymentState.current) gsap.fromTo(paymentState.current, {
        xPercent: -50, yPercent: -48, scale: 0.985, opacity: 0,
      }, {
        xPercent: -50, yPercent: -50, scale: 1, opacity: 1, duration: 0.34, ease: "power3.out",
      });
    }, paymentPanel);

    return () => context.revert();
  }, [busy, intent, error]);

  useLayoutEffect(() => {
    if (!paymentState.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      previousStep.current = step;
      return undefined;
    }
    const direction = step >= previousStep.current ? 1 : -1;
    previousStep.current = step;
    const active = paymentState.current.querySelector(".steps li.active");
    const detail = paymentState.current.querySelector(".customer-card, .success, .error");
    const context = gsap.context(() => {
      if (active) gsap.fromTo(active, { x: 6 * direction, opacity: 0.45 }, { x: 0, opacity: 1, duration: 0.32, ease: "power2.out", clearProps: "transform,opacity" });
      if (detail) gsap.fromTo(detail, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.38, ease: "power3.out", clearProps: "transform,opacity" });
    }, paymentState);
    return () => context.revert();
  }, [step, error]);

  useLayoutEffect(() => {
    if (!setupOpen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const context = gsap.context(() => {
      gsap.fromTo(".modal-backdrop", { opacity: 0 }, { opacity: 1, duration: 0.2, ease: "power1.out" });
      gsap.fromTo(".setup-dialog", { xPercent: -50, yPercent: -48, scale: 0.985, opacity: 0 }, {
        xPercent: -50, yPercent: -50, scale: 1, opacity: 1, duration: 0.3, ease: "power3.out",
      });
    });
    return () => context.revert();
  }, [setupOpen]);

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
      await client.ensurePrompt();
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
        : created.funding?.status === "failed" ? " App installed, but automated funding failed; use the public faucet on the sender card, then refresh the balance." : "";
      setSetupMessage(`SolarPay Sender and Merchant are ready on one wallet.${funded}`);
    } catch (reason) {
      if (reason?.name === "NotFoundError") {
        setSerialState("disconnected");
        setSerialMessage("Device selection was cancelled. Choose Connect another user to try again.");
        setSetupMessage("Device selection was cancelled.");
      } else {
        setSetupMessage(reason.message);
      }
    }
    finally { setSetupBusy(false); }
  }

  async function toggleSerial() {
    const client = serialClient.current;
    if (!client) return;
    if (serialState === "connected") {
      await client.disconnect();
      setSetupMessage("Badge disconnected. Connect another badge when you’re ready.");
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
      await client.installApp(source, ({ stage, message }) => setInstallStatus({ stage, message }));
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
          await serialClient.current.installApp(bundle.source, ({ stage, message }) => setInstallStatus({
            stage,
            message: `App ${index + 1}/2 · ${message}`,
          }), files);
        }
      }
    } catch (reason) {
      if (reason?.name === "NotFoundError") setInstallStatus({ stage: "error", message: "Device selection was cancelled." });
      else setInstallStatus({ stage: "error", message: reason.message || "SolarPay installation failed." });
    }
  }

  async function installSolarPayForBadge(badge) {
    for (const [index, role] of ["customer", "merchant"].entries()) {
      const response = await fetch(`/api/badges/${badge.badgeId}/solarpay-bundle?role=${role}`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!response.ok) throw new Error(`Could not load the personalized SolarPay ${role === "customer" ? "Sender" : "Merchant"} app.`);
      const bundle = await response.json();
      const files = bundle.files.map((file) => ({
        path: file.path,
        bytes: Uint8Array.from(atob(file.data), (character) => character.charCodeAt(0)),
      }));
      await serialClient.current.installApp(bundle.source, ({ stage, message }) => setInstallStatus({
        stage,
        message: `App ${index + 1}/2 · ${message}`,
      }), files);
    }
  }

  async function syncBadge(badge) {
    setSyncedBadge(badge); setBalance(null); setQrCode(""); setSyncBusy(true); setSetupMessage("");
    try {
      const info = await request(`/badges/${badge.badgeId}/balance`, {}, apiKey);
      setBalance(info);
      if (badge.role === "customer" || badge.roles?.includes("customer")) setQrCode(await QRCode.toDataURL(`solana:${badge.solanaAddress}`, { width: 260, margin: 1, color: { dark: "#21152f", light: "#ffffff" } }));
    } catch (reason) { setSetupMessage(reason.message); }
    finally { setSyncBusy(false); }
  }

  async function fundSender() {
    if (!syncedBadge || !(syncedBadge.role === "customer" || syncedBadge.roles?.includes("customer"))) return;
    setSyncBusy(true); setSetupMessage("");
    try {
      const result = await request(`/badges/${syncedBadge.badgeId}/airdrop`, { method: "POST" }, apiKey);
      setBalance({ ...result, solanaAddress: syncedBadge.solanaAddress, role: "customer" });
      setSetupMessage(`Faucet confirmed ${(result.funding.lamports / 1e9).toLocaleString()} SOL for ${syncedBadge.badgeId}.`);
    } catch (reason) { setSetupMessage(`Faucet request failed: ${reason.message}`); }
    finally { setSyncBusy(false); }
  }

  async function refreshBalance() {
    if (!syncedBadge) return;
    await syncBadge(syncedBadge);
  }

  const lamports = useMemo(() => Math.round(Number(amountSol) * 1_000_000_000), [amountSol]);

  async function createPayment(event) {
    event.preventDefault();
    setBusy(true); setError(""); setIntent(null); activeIntent.current = null;
    try {
      if (serialState !== "connected" || !serialClient.current?.writer) throw new Error("Connect the merchant badge before starting checkout.");
      const created = await request("/intents", { method: "POST", body: JSON.stringify({ terminalBadgeId, amountLamports: lamports, memo }) }, apiKey);
      setIntent(created); activeIntent.current = created; setStep(1);
      await serialClient.current.writeAppFile("solarpay_merchant", "intent.txt", `${created.radioPacket}\n${created.radioItemPacket}\n`, { triggerButton: "START" });
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
      try {
        await serialClient.current?.writeAppFile("solarpay_merchant", "intent.txt", `SP1:C:${current.id}\n`, { triggerButton: "START" });
      } catch (receiptError) {
        setSerialMessage(`Payment confirmed, but the badge receipt update failed: ${receiptError.message}`);
      }
      const merchant = badges.find((badge) => badge.badgeId === current.terminalBadgeId);
      if (merchant) void syncBadge(merchant);
    } catch (reason) {
      setError(reason.message);
      try { await serialClient.current?.writeAppFile("solarpay_merchant", "intent.txt", `SP1:E:${current.id}\n`, { triggerButton: "START" }); } catch {}
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
        await serialClient.current?.writeAppFile("solarpay_merchant", "intent.txt", `SP1:E:${current.id}\n`, { triggerButton: "START" });
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

  const setupRole = journey === "sender" ? "customer" : "merchant";
  const setupRoleLabel = journey === "sender" ? "sender badge" : "merchant terminal";

  function openSetup() {
    setSetupStage(0);
    setSetupMessage("");
    setSetupOpen(true);
  }

  function animateDisclosure(event) {
    if (!event.currentTarget.open || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const content = event.currentTarget.querySelector(".wallet-line, .transactions-content, .advanced-actions");
    if (content) gsap.fromTo(content, { y: -6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.28, ease: "power2.out", clearProps: "transform,opacity" });
  }

  const paymentIsActive = journey === "merchant" && (busy || !!intent || !!error);
  const paymentCanCancel = Boolean(activeIntent.current && intent && step <= 2);

  return <main className="app-shell" ref={appShell}>
    <header className="topbar">
      <div className="brand"><div className="mark">S</div><div><h1>SolarPay</h1><p>Badge payments</p></div></div>
      <nav className="tabs" aria-label="SolarPay setup paths">
        <button className={journey === "sender" ? "active" : ""} onClick={() => { setJourney("sender"); setSetupStage(0); setSetupMessage(""); }}>Sender</button>
        <button className={journey === "merchant" ? "active" : ""} onClick={() => { setJourney("merchant"); setSetupStage(0); setSetupMessage(""); }}>Merchant</button>
      </nav>
      <div className="top-actions"><span className="network"><i />{network}</span><span className="header-user">{syncedBadge ? syncedBadge.badgeId : "No badge"}</span></div>
    </header>

    <div className="content classic-layout">
      <section className="hero">
        <h2>{journey === "sender" ? "Set up a badge that can pay." : "Take a payment from a nearby badge."}</h2>
        <p>{journey === "sender" ? "Connect once, then hold the badge near a checkout and confirm the item and amount." : "Connect a terminal, enter the item and amount, then let the badges handle the rest."}</p>
      </section>

      <section className="setup-intro panel">
        <div className="setup-copy">
          <h3>Prepare your {setupRoleLabel}</h3>
          <p>{syncedBadge ? `Using ${syncedBadge.badgeId}. Disconnect it from Badge status before connecting another user.` : "Connect your badge over USB. SolarPay creates one wallet, installs both role apps, and verifies they are ready."}</p>
          <button className="setup-cta" onClick={openSetup} disabled={serialState === "connected"}>{syncedBadge ? `Connected as ${syncedBadge.badgeId}` : `Set up ${setupRoleLabel}`} <span>→</span></button>
          {setupMessage && <p className="setup-message">{setupMessage}</p>}
        </div>
        <ol className="onboarding-steps">
          <li><span>1</span><div><b>Connect</b><small>Choose the USB badge</small></div></li>
          <li><span>2</span><div><b>Install</b><small>Load Sender and Merchant</small></div></li>
          <li><span>3</span><div><b>Use SolarPay</b><small>Pay or receive nearby</small></div></li>
        </ol>
      </section>

      <div className="layout device-layout">
        <section className="panel synced-panel compact-badge-panel">
          {syncedBadge ? <>
            <div className="panel-title"><div><h3>{syncedBadge.badgeId}</h3></div><span className="role-label">Sender + Merchant</span></div>
            <div className="badge-summary">
              <div className="balance-block"><span>Balance</span><strong>{syncBusy || !balance ? "—" : `${balance.sol.toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL`}</strong></div>
              <details className="wallet-details" onToggle={animateDisclosure}><summary>Wallet details</summary><div className="wallet-line"><span>Address</span><code>{syncedBadge.solanaAddress}</code>{balance?.explorerUrl && <a href={balance.explorerUrl} target="_blank" rel="noreferrer">View on Explorer ↗</a>}</div></details>
              <div className="funding-actions">
                <button className="subtle-action" onClick={fundSender} disabled={syncBusy}>{syncBusy ? "Requesting…" : "Add test SOL"}</button>
                <button className="text-action" onClick={refreshBalance} disabled={syncBusy}>Refresh balance</button>
              </div>
              {network !== "MOCK" && <p className="funding-help">If the automatic airdrop is unavailable, fund this wallet with the <a href={DEVNET_FAUCET_URL} target="_blank" rel="noreferrer">Solana public faucet ↗</a>, then refresh.</p>}
            </div>
          </> : <div className="badge-summary-empty"><h3>No badge yet</h3><span>Use setup above to add one.</span></div>}
        </section>

        <section className="panel connection-panel">
          <div className="panel-title"><div><h3>Badge status</h3></div><span className={`connection-dot ${serialState}`} /></div>
          <div className="connection-summary"><b>{serialState === "connected" ? "Badge connected" : "No badge connected"}</b><p>{serialMessage}</p>{proximity && <small>{proximity.zone.replace("_", " ")} · {proximity.rssi} dBm</small>}</div>
          <button className="connection-button" onClick={serialState === "connected" ? toggleSerial : openSetup} disabled={!webSerialSupported() || serialState === "requesting"}>{serialState === "connected" ? "Disconnect user" : serialState === "requesting" ? "Choose device…" : "Connect another user"}</button>
          <details className="advanced-tools" onToggle={animateDisclosure}>
            <summary>Advanced tools</summary>
            <input ref={luaFileInput} type="file" accept=".lua,text/plain" hidden onChange={chooseLuaApp} />
            <div className="advanced-actions"><button onClick={() => luaFileInput.current?.click()}>Choose Lua app</button>{selectedLuaApp && <button onClick={() => installLuaSource(selectedLuaApp.source)}>Install {selectedLuaApp.name}</button>}<button onClick={installSolarPay}>Reinstall SolarPay</button><button onClick={() => setSerialLines([])} disabled={!serialLines.length}>Clear log</button></div>
            {installStatus.message && <p className={`install-status ${installStatus.stage}`}>{installStatus.message}</p>}
            <div className="serial-log serial-monitor" ref={serialLog} role="log" aria-live="polite" aria-label="Badge serial output">{serialLines.length === 0 ? <span>No serial output yet.</span> : serialLines.map((line, index) => <div className={`serial-line ${line.kind}`} key={`${line.at}-${index}`}><time>{line.at}</time><span>{line.kind === "event" ? line.event : line.kind}</span><code>{line.text}</code></div>)}</div>
          </details>
        </section>
      </div>

      {journey === "merchant" && <section ref={paymentPanel} className={`panel payment-panel ${paymentIsActive ? "payment-panel-active" : ""}`}>
        <div className="checkout-workspace">
          <div className="workspace-heading"><div><h3>Create checkout</h3></div><span>{terminalBadgeId || "No terminal"}</span></div>
          <form onSubmit={createPayment}><label>Item<input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={64} placeholder="Coffee" required /></label><label>Amount<div className="amount"><span>◎</span><input type="number" min="0.000000001" step="0.000000001" value={amountSol} onChange={(e) => setAmountSol(e.target.value)} required /><b>SOL</b></div></label><button className="primary" disabled={busy || !!intent || !terminalBadgeId || serialState !== "connected"}>{busy && !intent ? "Sending…" : !terminalBadgeId ? "Select a terminal" : serialState !== "connected" ? "Connect terminal" : "Request payment"}</button></form>
        </div>
      </section>}
      {journey === "merchant" && <details className="panel transactions-panel progressive-panel" onToggle={animateDisclosure}>
        <summary><div><h3>Recent payments</h3><span>{transactions.length === 0 ? "No activity yet" : `${transactions.length} payment${transactions.length === 1 ? "" : "s"}`}</span></div><span className="summary-action">View history</span></summary>
        <div className="transactions-content"><button className="text-button" onClick={loadTransactions}>Refresh</button><div className="transactions-list">{transactions.length === 0 ? <p className="empty-row">No payments yet.</p> : transactions.map((transaction) => <div className="transaction-row" key={transaction.id}><span className={`transaction-status ${transaction.status}`} /> <div><b>{transaction.memo || "Payment"}</b><small>{transaction.customerBadgeId ? `${transaction.customerBadgeId} → ${transaction.terminalBadgeId}` : transaction.terminalBadgeId}</small></div><strong>{(transaction.amountLamports / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL</strong><span className="transaction-state">{transaction.status}</span>{transaction.explorerUrl ? <a href={transaction.explorerUrl} target="_blank" rel="noreferrer">Explorer ↗</a> : <span className="transaction-id">{transaction.id}</span>}</div>)}</div></div>
      </details>}
      <footer><span>Wallet keys stay encrypted on this computer.</span></footer>
    </div>

    <Dialog.Root open={paymentIsActive}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop payment-backdrop" />
        <Dialog.Content
          className={`payment-dialog ${error ? "has-error" : step === 5 ? "is-complete" : ""}`}
          ref={paymentState}
          aria-live="polite"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <button
            className="modal-close"
            aria-label={step === 5 || (error && !paymentCanCancel) ? "Close payment" : "Cancel payment"}
            disabled={busy || (step > 2 && step < 5)}
            onClick={step === 5 || (error && !paymentCanCancel) ? reset : cancelPayment}
          ><X size={18} strokeWidth={2} /></button>

          <div className="payment-dialog-head">
            <span className="payment-dialog-mark">S</span>
            <div>
              <Dialog.Title>{step === 5 ? "Payment complete" : error ? "Payment stopped" : step >= 2 ? "Waiting for payment" : "Preparing request"}</Dialog.Title>
              <Dialog.Description>{step === 5 ? "The transaction was confirmed on-chain." : error ? "Nothing was charged." : step >= 2 ? "Keep this window open while the sender approves." : "Creating and broadcasting the checkout…"}</Dialog.Description>
            </div>
          </div>

          <ol className="steps compact-steps">{STEPS.map((name, index) => <li key={name} className={index < step ? "done" : index === step ? "active" : ""}><span>{index < step ? "✓" : index + 1}</span><div><b>{name}</b>{index === 2 && step === 2 && intent && <small>{remaining}s</small>}</div></li>)}</ol>

          {intent && step === 2 && <div className="customer-card"><p>Ready to pay</p><h2>{intent.memo || "Payment"} · {(intent.amountLamports / 1e9).toFixed(4)} SOL</h2><small>{remaining}s remaining</small><div className="tap-instruction">Hold the sender badge near this terminal, then confirm on the sender.</div></div>}
          {step === 5 && intent && <div className="success"><span>✓</span><div><b>Confirmed on {network}</b><small>{intent.signature}</small>{intent.explorerUrl && <a href={intent.explorerUrl} target="_blank" rel="noreferrer">View transaction on Solana Explorer ↗</a>}</div></div>}
          {error && <div className="error"><b>Payment stopped</b><span>{error}</span></div>}

          <div className="payment-dialog-actions">
            {step === 5 || (error && !paymentCanCancel) ? <button className="dialog-primary" onClick={reset}>{step === 5 ? "New payment" : "Back to checkout"}</button> : <button className="cancel-payment" onClick={cancelPayment} disabled={busy || !paymentCanCancel}>{busy && intent ? "Cancelling…" : error ? "Try cancelling again" : "Cancel payment"}</button>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root open={setupOpen} onOpenChange={(open) => { if (open || !setupBusy) setSetupOpen(open); }}>
      <Dialog.Portal>
      <Dialog.Overlay className="modal-backdrop" />
      <Dialog.Content className="setup-dialog" onEscapeKeyDown={(event) => { if (setupBusy) event.preventDefault(); }} onPointerDownOutside={(event) => { if (setupBusy) event.preventDefault(); }}>
        <Dialog.Close asChild><button className="modal-close" aria-label="Close setup" disabled={setupBusy}><X size={18} strokeWidth={2} /></button></Dialog.Close>
        <div className={`dialog-visual stage-${setupStage}`}><span>{setupStage === 3 ? "✓" : setupStage === 0 ? "S" : setupStage}</span></div>
        <div className="dialog-progress" aria-label={`Setup step ${Math.min(setupStage + 1, 3)} of 3`}><i className="active" /><i className={setupStage >= 2 ? "active" : ""} /><i className={setupStage >= 3 ? "active" : ""} /></div>

        {setupStage === 0 && <><p className="dialog-kicker">STEP 1 OF 3</p><Dialog.Title asChild><h2>Plug in your badge</h2></Dialog.Title><Dialog.Description asChild><p>Use a USB data cable and close the Badge IDE if it’s open.</p></Dialog.Description><button className="dialog-primary" onClick={() => setupBadge(setupRole)}>Connect badge</button><small>Your browser will ask you to choose a device.</small></>}
        {setupStage === 1 && <><p className="dialog-kicker">STEP 1 OF 3</p><Dialog.Title asChild><h2>Connecting…</h2></Dialog.Title><Dialog.Description asChild><p>Choose the USB serial device for your badge. Keep this window open.</p></Dialog.Description><div className="dialog-loading"><i /></div></>}
        {setupStage === 2 && <><p className="dialog-kicker">STEP 2 OF 3</p><Dialog.Title asChild><h2>Installing SolarPay…</h2></Dialog.Title><Dialog.Description asChild><p>{journey === "sender" ? "Your wallet is ready. We’re adding the app to your badge." : "Your receiving wallet is ready. We’re adding the app to your terminal."}</p></Dialog.Description><div className="dialog-loading"><i /></div></>}
        {setupStage === 3 && <><p className="dialog-kicker">ALL DONE</p><Dialog.Title asChild><h2>Your {setupRoleLabel} is ready</h2></Dialog.Title><Dialog.Description asChild><p>{setupMessage || "Open SolarPay from the badge launcher."}</p></Dialog.Description><Dialog.Close asChild><button className="dialog-primary">Done</button></Dialog.Close></>}

        {setupMessage && setupStage !== 3 && !setupBusy && <div className="dialog-error"><b>Setup paused</b><span>{setupMessage}</span><button onClick={() => setupBadge(setupRole)}>Try again</button></div>}
      </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </main>;
}
