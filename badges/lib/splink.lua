-- SPL1 - SolarPay Link, badge-to-badge pairing over the Lua BLE broadcast channel.
--
-- The badge exposes one shared, unauthenticated broadcast channel (badge.radio:
-- 44-byte frames, RSSI and BLE MAC on receive). Every armed badge in the room
-- hears every frame, so "which badge did I tap?" cannot be answered by the radio
-- alone -- RSSI at these distances overlaps badly between "touching" and "an
-- arm's length away".
--
-- SPL1 answers it with physics instead: a deliberate knock is felt by the
-- accelerometers of BOTH badges within a few tens of milliseconds, and by no
-- other badge in the room. Pairing requires a peer that (a) is armed, (b) is
-- loud on RSSI, (c) reports its own impact within BUMP_SKEW of ours, (d) felt a
-- similar-strength impact, and (e) is the ONLY such candidate. Anything else is
-- refused rather than guessed at.
--
-- This module is pure Lua with no badge API calls; the host injects ms/send/log/
-- random. That keeps it testable off-badge (see test/splink.test.lua).
--
-- Frames are fixed-width ASCII so parsing is a few string.sub calls:
--   SPL1H <role:1> <sid:4> <flags:1>                        <crc:4>  beacon
--   SPL1K <sid:4> <dt:3> <mag:2>                            <crc:4>  bump
--   SPL1P <sid:4> <psid:4> <dt:3> <mag:2>                   <crc:4>  pair request
--   SPL1C <sid:4> <psid:4>                                  <crc:4>  pair confirm
--   SPL1D <lid:4> <seq:1> <cnt:1> <body:0..24>              <crc:4>  data fragment
--   SPL1A <lid:4> <seq:1>                                   <crc:4>  ack
--   SPL1X <lid:4> <code:1>                                  <crc:4>  close
--
-- The CRC is integrity only. It is not authentication: a broadcast channel with
-- no crypto primitives in Lua cannot provide that on-badge. The pairing decision
-- above, plus the explicit user confirmation the app requires afterwards, is
-- what prevents a wrong or accidental counterparty. Authority over the actual
-- payment stays with the backend, which verifies the badge/nonce mapping.

local splink = {}

splink.VERSION = "SPL1"

-- Tunables. Defaults are deliberate; calibrate RSSI_GATE with solarpay_pair.
--
-- RSSI_GATE is deliberately loose. The previous design used RSSI as the whole
-- proximity test and had to keep widening it -- -55, then -62 -- because badges
-- held edge to edge still read below the tighter values through the enclosure
-- and lanyard. Setting a tight gate here would simply stop pairing from ever
-- firing. It is a coarse "same table, not across the room" filter; the sharp
-- discrimination comes from requiring both badges to feel the same knock at the
-- same instant, which no bystander badge can fake by standing close.
local DEFAULTS = {
  RSSI_GATE      = -70,   -- dBm, smoothed; coarse range filter, not the tap test
  RSSI_ALPHA     = 3,     -- EMA weight: new = (old*ALPHA + sample)/(ALPHA+1)
  PEER_TTL       = 2000,  -- ms a peer stays known after its last frame
  BEACON_MS      = 400,   -- ms between beacons while armed
  BUMP_WINDOW    = 1200,  -- ms our own impact stays eligible to complete a pairing
  BUMP_SKEW      = 150,   -- ms max difference between the two felt impacts
  BUMP_REBROADCAST = 60,  -- ms between repeats of our own K frame
  BUMP_REPEATS   = 5,     -- how many times we re-announce one impact
  IMPACT_REFRACTORY = 400,-- ms before a new knock can replace the current one
  MAG_TOL        = 64,    -- sanity check only on impact strength (units of 16 mg)
  IMPACT_MG      = 350,   -- mg deviation from rest that counts as a knock
  PAIR_SETTLE    = 220,   -- ms to wait after our own knock before deciding
  PAIR_TIMEOUT   = 900,   -- ms to complete the P/C handshake
  PAIR_RETRY_MS  = 120,   -- ms between retransmits of a pair request
  ARM_MS         = 20000, -- ms an arm lasts before falling back to idle
  DATA_RETRY_MS  = 140,   -- ms between retransmits of an unacked fragment
  DATA_TRIES     = 12,    -- retransmits before giving up on a fragment
  DATA_TIMEOUT   = 3000,  -- ms for a whole message
  MAX_BODY       = 24,    -- bytes of payload per data fragment
}

splink.DEFAULTS = DEFAULTS

-- States -------------------------------------------------------------------
splink.IDLE    = "idle"
splink.ARMED   = "armed"
splink.PAIRING = "pairing"
splink.PAIRED  = "paired"

-- Close/abort codes (single char, travels in X frames)
splink.OK        = "0"
splink.CANCELLED = "1"
splink.TIMEOUT   = "2"
splink.AMBIGUOUS = "3"
splink.EXPIRED   = "4"

local HEX = "0123456789abcdef"

local function hex1(n)
  n = n % 16
  return string.sub(HEX, n + 1, n + 1)
end

local function hex2(n)
  if n < 0 then n = 0 elseif n > 255 then n = 255 end
  n = math.floor(n)
  return hex1(math.floor(n / 16)) .. hex1(n)
end

local function hex4(n)
  n = math.floor(n) % 65536
  return hex2(math.floor(n / 256)) .. hex2(n % 256)
end

local function unhex(s)
  if not s then return nil end
  local v = 0
  for i = 1, #s do
    local c = string.byte(s, i)
    local d
    if c >= 48 and c <= 57 then d = c - 48
    elseif c >= 97 and c <= 102 then d = c - 87
    elseif c >= 65 and c <= 70 then d = c - 55
    else return nil end
    v = v * 16 + d
  end
  return v
end

local function dec3(n)
  if n < 0 then n = 0 elseif n > 999 then n = 999 end
  return string.format("%03d", math.floor(n))
end

splink.hex2, splink.hex4, splink.unhex = hex2, hex4, unhex

-- CRC-16/CCITT-FALSE, table-free so it costs no startup allocation. Frames are
-- short (<= 44 bytes) so the bit loop stays well inside a tick budget.
function splink.crc16(s)
  local crc = 0xFFFF
  for i = 1, #s do
    crc = crc ~ (string.byte(s, i) << 8)
    crc = crc & 0xFFFF
    for _ = 1, 8 do
      if (crc & 0x8000) ~= 0 then
        crc = ((crc << 1) ~ 0x1021) & 0xFFFF
      else
        crc = (crc << 1) & 0xFFFF
      end
    end
  end
  return crc
end

local function seal(body)
  return body .. hex4(splink.crc16(body))
end

local function unseal(frame)
  if type(frame) ~= "string" or #frame < 9 then return nil end
  if string.sub(frame, 1, 4) ~= splink.VERSION then return nil end
  local body = string.sub(frame, 1, #frame - 4)
  if unhex(string.sub(frame, -4)) ~= splink.crc16(body) then return nil end
  return body
end

splink.seal, splink.unseal = seal, unseal

-- The link id both badges derive independently from the two session ids, so
-- data frames can drop the full pair of ids and spend those bytes on payload.
function splink.link_id(sid_a, sid_b)
  local lo, hi = sid_a, sid_b
  if lo > hi then lo, hi = hi, lo end
  return hex4(splink.crc16(lo .. hi))
end

-- Link ----------------------------------------------------------------------

local Link = {}
-- Methods are copied onto each instance below: the badge sandbox documents no
-- metatable support, so nothing here relies on setmetatable.

-- env = { ms=fn, send=fn(payload)->bool, log=fn(string)|nil, random=fn(n)->0..n-1 }
-- opts overrides any DEFAULTS key, plus role = "S" (sender) or "M" (merchant).
function splink.new(env, opts)
  opts = opts or {}
  local self = {}
  for name, fn in pairs(Link) do self[name] = fn end
  self.env = env
  self.role = opts.role or "S"
  self.cfg = {}
  for k, v in pairs(DEFAULTS) do
    self.cfg[k] = opts[k] ~= nil and opts[k] or v
  end
  self.state = splink.IDLE
  self.sid = nil
  self.peers = {}          -- mac -> { sid, role, armed, rssi, seen, bump_at, bump_mag }
  self.peer = nil          -- the paired peer's record
  self.lid = nil
  self.armed_until = 0
  self.next_beacon = 0
  self.bump_at = nil       -- ms of our own most recent impact
  self.bump_mag = 0
  self.bump_sent = 0
  self.next_bump_send = 0
  self.pair_deadline = 0
  self.rest = nil          -- accelerometer rest magnitude, learned at arm time
  self.tx = nil            -- outbound message in flight
  self.rx = nil            -- inbound message being assembled
  self.handlers = {}
  return self
end

function Link:on(event, fn) self.handlers[event] = fn end

function Link:emit(event, a, b)
  local fn = self.handlers[event]
  if fn then fn(a, b) end
end

function Link:log(s)
  if self.env.log then self.env.log("SPL1|" .. s) end
end

function Link:send_raw(body)
  local frame = seal(body)
  if #frame > 44 then
    self:log("oversize|len=" .. #frame)
    return false
  end
  return self.env.send(frame) and true or false
end

local function new_sid(self)
  local r = self.env.random and self.env.random(65536) or 0
  return hex4(r)
end

-- Arming --------------------------------------------------------------------

-- Begin a pairing window. Nothing pairs unless both badges are armed.
function Link:arm()
  local now = self.env.ms()
  self.sid = new_sid(self)
  self.state = splink.ARMED
  self.armed_until = now + self.cfg.ARM_MS
  self.next_beacon = 0
  self.peers = {}
  self.peer = nil
  self.lid = nil
  self.bump_at = nil
  self.rest = nil
  self.tx = nil
  self.rx = nil
  self:log("arm|sid=" .. self.sid .. "|role=" .. self.role)
  self:emit("state", self.state)
  return self.sid
end

function Link:disarm(code)
  if self.state == splink.IDLE then return end
  if self.lid then
    self:send_raw(splink.VERSION .. "X" .. self.lid .. (code or splink.CANCELLED))
  end
  self.state = splink.IDLE
  self.peer = nil
  self.lid = nil
  self.tx = nil
  self.rx = nil
  self:log("disarm|code=" .. tostring(code))
  self:emit("state", self.state)
end

function Link:armed()
  return self.state ~= splink.IDLE
end

-- Motion --------------------------------------------------------------------

-- Feed one accelerometer sample (milligravity). Returns true when this sample
-- registered as an impact. Pass hw_tap=true when badge.sensor.tap() fired, which
-- the SC7A20H detects in hardware and is the more reliable trigger.
--
-- Call this every tick from the moment the app arms, not only when you think
-- something happened: the first samples establish the resting magnitude that
-- every later impact is measured against.
function Link:feed_accel(x, y, z, hw_tap)
  if self.state == splink.IDLE then return false end
  if not x then
    -- No accelerometer reading available, only the hardware tap line. Report a
    -- nominal strength so the two badges still agree on magnitude.
    if hw_tap then return self:register_impact(self.cfg.IMPACT_MG) end
    return false
  end
  local mag = math.floor(math.sqrt(x * x + y * y + z * z))
  if not self.rest then
    -- First sample: there is nothing to compare against yet.
    self.rest = mag
    return false
  end
  local dev = math.abs(mag - self.rest)
  -- Track rest slowly so orientation changes do not read as a permanent impact.
  self.rest = math.floor((self.rest * 15 + mag) / 16)
  if hw_tap or dev >= self.cfg.IMPACT_MG then
    return self:register_impact(dev)
  end
  return false
end

function Link:register_impact(dev)
  local now = self.env.ms()
  -- A knock rings the accelerometer for a while, so ignore the ring-down. This
  -- is shorter than BUMP_WINDOW: the window bounds how long a pairing may take
  -- to complete, the refractory bounds how often a new knock may be declared.
  if self.bump_at and now - self.bump_at < self.cfg.IMPACT_REFRACTORY then return false end
  self.bump_at = now
  self.bump_mag = math.floor(dev / 16)
  if self.bump_mag > 255 then self.bump_mag = 255 end
  self.bump_sent = 0
  self.next_bump_send = 0
  self:log("impact|mag=" .. self.bump_mag)
  self:emit("impact", self.bump_mag)
  return true
end

-- Receive -------------------------------------------------------------------

function Link:touch_peer(mac, rssi)
  local p = self.peers[mac]
  local now = self.env.ms()
  if not p then
    p = { mac = mac, rssi = rssi, seen = now }
    self.peers[mac] = p
  else
    local a = self.cfg.RSSI_ALPHA
    p.rssi = math.floor((p.rssi * a + rssi) / (a + 1))
    p.seen = now
  end
  return p
end

-- Feed one received radio frame. mac/rssi come straight from badge.radio.
function Link:on_frame(mac, rssi, payload)
  if self.state == splink.IDLE then return false end
  local body = unseal(payload)
  if not body then return false end
  local kind = string.sub(body, 5, 5)
  local now = self.env.ms()

  if kind == "H" then
    local p = self:touch_peer(mac, rssi)
    p.role = string.sub(body, 6, 6)
    p.sid = string.sub(body, 7, 10)
    p.armed = string.sub(body, 11, 11) == "1"
    return true
  end

  if kind == "K" then
    local p = self:touch_peer(mac, rssi)
    p.sid = string.sub(body, 6, 9)
    local dt = tonumber(string.sub(body, 10, 12))
    local mag = unhex(string.sub(body, 13, 14))
    if not dt or not mag then return false end
    p.bump_at = now - dt
    p.bump_mag = mag
    self:log("peer_bump|sid=" .. tostring(p.sid) .. "|rssi=" .. p.rssi .. "|mag=" .. mag)
    self:try_pair()
    return true
  end

  if kind == "P" then
    local psid = string.sub(body, 10, 13)
    if psid ~= self.sid then return false end
    -- Our confirm can be lost; the initiator retransmits P until it hears one.
    if self.state == splink.PAIRED then
      if self.peer and self.peer.mac == mac then
        self:send_raw(splink.VERSION .. "C" .. self.sid .. self.peer.sid)
        return true
      end
      return false
    end
    if self.state ~= splink.ARMED then return false end
    local p = self:touch_peer(mac, rssi)
    p.sid = string.sub(body, 6, 9)
    local dt = tonumber(string.sub(body, 14, 16))
    local mag = unhex(string.sub(body, 17, 18))
    if not dt or not mag then return false end
    p.bump_at = now - dt
    p.bump_mag = mag
    -- Same settle rule as try_pair. The initiator retransmits, so refusing an
    -- early request costs one retry, not the pairing.
    if not self.bump_at or now - self.bump_at < self.cfg.PAIR_SETTLE then return false end
    -- Accepting a request is as consequential as making one, so it runs the
    -- same uniqueness test: if anyone else also qualifies, refuse them all.
    local best, count = self:candidates(now)
    if count ~= 1 or best ~= p then
      self:log("pair_refused|sid=" .. tostring(p.sid) .. "|candidates=" .. count)
      if count > 1 then self:emit("ambiguous", count) end
      return false
    end
    self:send_raw(splink.VERSION .. "C" .. self.sid .. p.sid)
    self:enter_paired(p)
    return true
  end

  if kind == "C" then
    if self.state ~= splink.PAIRING then return false end
    local psid = string.sub(body, 10, 13)
    if psid ~= self.sid then return false end
    local p = self:touch_peer(mac, rssi)
    if self.pending and self.pending.mac ~= mac then return false end
    p.sid = string.sub(body, 6, 9)
    self:enter_paired(p)
    return true
  end

  if kind == "D" or kind == "A" or kind == "X" then
    if self.state ~= splink.PAIRED then return false end
    if string.sub(body, 6, 9) ~= self.lid then return false end
    if mac ~= self.peer.mac then return false end
    self:touch_peer(mac, rssi)
    if kind == "A" then return self:on_ack(unhex(string.sub(body, 10, 10))) end
    if kind == "X" then
      local code = string.sub(body, 10, 10)
      self:log("peer_closed|code=" .. code)
      self.state = splink.IDLE
      self:emit("closed", code)
      self:emit("state", self.state)
      return true
    end
    return self:on_data(unhex(string.sub(body, 10, 10)),
                        unhex(string.sub(body, 11, 11)),
                        string.sub(body, 12))
  end

  return false
end

-- Pairing -------------------------------------------------------------------

-- Every condition a peer must satisfy before it can become our counterparty.
function Link:candidate_ok(p, now)
  if not p.armed and not p.bump_at then return false end
  if now - p.seen > self.cfg.PEER_TTL then return false end
  if p.rssi < self.cfg.RSSI_GATE then return false end
  if not self.bump_at or not p.bump_at then return false end
  if now - self.bump_at > self.cfg.BUMP_WINDOW then return false end
  if math.abs(self.bump_at - p.bump_at) > self.cfg.BUMP_SKEW then return false end
  if math.abs(self.bump_mag - p.bump_mag) > self.cfg.MAG_TOL then return false end
  if p.role == self.role then return false end
  return true
end

function Link:candidates(now)
  local found, count = nil, 0
  for _, p in pairs(self.peers) do
    if self:candidate_ok(p, now) then
      count = count + 1
      if not found or p.rssi > found.rssi then found = p end
    end
  end
  return found, count
end

function Link:try_pair()
  if self.state ~= splink.ARMED then return false end
  local now = self.env.ms()
  -- Deliberately slow. Deciding on the first frame that arrives would let
  -- whichever badge happens to transmit first win, before a second badge that
  -- also knocked has had any chance to announce itself. Waiting PAIR_SETTLE ms
  -- means the ambiguity check below sees every candidate, not just the fastest.
  if not self.bump_at or now - self.bump_at < self.cfg.PAIR_SETTLE then return false end
  local best, count = self:candidates(now)
  if count == 0 then return false end
  if count > 1 then
    -- Two badges knocked at the same instant while both were close and armed.
    -- There is no honest way to pick; make the user try again on their own.
    self:log("ambiguous|count=" .. count)
    self:emit("ambiguous", count)
    self.bump_at = nil
    return false
  end
  -- Deterministic initiator so both badges do not send P at each other.
  if self.sid > best.sid then
    self.state = splink.PAIRING
    self.pending = best
    self.pair_deadline = now + self.cfg.PAIR_TIMEOUT
    self.next_pair_send = 0
    self:emit("state", self.state)
    self:send_pair_request(now)
  end
  return true
end

function Link:send_pair_request(now)
  if not self.pending or not self.bump_at then return false end
  self.next_pair_send = now + self.cfg.PAIR_RETRY_MS
  return self:send_raw(splink.VERSION .. "P" .. self.sid .. self.pending.sid ..
                       dec3(now - self.bump_at) .. hex2(self.bump_mag))
end

function Link:enter_paired(p)
  self.state = splink.PAIRED
  self.peer = p
  self.pending = nil
  self.lid = splink.link_id(self.sid, p.sid)
  self.tx = nil
  self.rx = nil
  self:log("paired|sid=" .. self.sid .. "|peer=" .. p.sid .. "|lid=" .. self.lid ..
           "|rssi=" .. p.rssi)
  self:emit("paired", p)
  self:emit("state", self.state)
end

function Link:paired_peer()
  return self.peer
end

-- Messaging -----------------------------------------------------------------

-- Queue one message for the paired peer. Fragmented, stop-and-wait, acked.
function Link:send_message(text)
  if self.state ~= splink.PAIRED then return false, "not_paired" end
  if self.tx then return false, "busy" end
  local max = self.cfg.MAX_BODY
  local count = math.ceil(#text / max)
  if count < 1 then count = 1 end
  if count > 15 then return false, "too_long" end
  local parts = {}
  for i = 1, count do
    parts[i] = string.sub(text, (i - 1) * max + 1, i * max)
  end
  self.tx = { parts = parts, count = count, seq = 1, tries = 0,
              next_at = 0, deadline = self.env.ms() + self.cfg.DATA_TIMEOUT }
  return true
end

function Link:sending()
  return self.tx ~= nil
end

function Link:on_ack(seq)
  if not self.tx or seq ~= self.tx.seq then return false end
  if self.tx.seq >= self.tx.count then
    self.tx = nil
    self:log("sent")
    self:emit("sent")
    return true
  end
  self.tx.seq = self.tx.seq + 1
  self.tx.tries = 0
  self.tx.next_at = 0
  return true
end

function Link:on_data(seq, count, body)
  if not seq or not count or count < 1 then return false end
  if not self.rx or self.rx.count ~= count then
    self.rx = { count = count, got = 0, parts = {} }
  end
  if not self.rx.parts[seq] then
    self.rx.parts[seq] = body
    self.rx.got = self.rx.got + 1
  end
  self:send_raw(splink.VERSION .. "A" .. self.lid .. hex1(seq))
  if self.rx.got < count then return true end
  local text = ""
  for i = 1, count do
    if not self.rx.parts[i] then return true end
    text = text .. self.rx.parts[i]
  end
  self.rx = nil
  self:log("received|len=" .. #text)
  self:emit("message", text)
  return true
end

-- Tick ----------------------------------------------------------------------

-- Call once per on_tick. Cheap: a few comparisons and at most one radio send.
function Link:tick()
  if self.state == splink.IDLE then return end
  local now = self.env.ms()

  if now >= self.armed_until then
    self:log("arm_expired")
    self:disarm(splink.EXPIRED)
    self:emit("expired")
    return
  end

  -- Forget stale peers so an old neighbour cannot satisfy the bump test later.
  for mac, p in pairs(self.peers) do
    if now - p.seen > self.cfg.PEER_TTL and p ~= self.peer then
      self.peers[mac] = nil
    end
  end

  if self.bump_at and now - self.bump_at > self.cfg.BUMP_WINDOW then
    self.bump_at = nil
  end

  if self.state == splink.PAIRING then
    if now >= self.pair_deadline then
      self:log("pair_timeout")
      self.state = splink.ARMED
      self.pending = nil
      self:emit("pair_failed", splink.TIMEOUT)
      self:emit("state", self.state)
    elseif now >= (self.next_pair_send or 0) then
      self:send_pair_request(now)
      return
    end
  end

  -- Announce our own impact a few times; a single frame is easy to lose.
  if self.bump_at and self.bump_sent < self.cfg.BUMP_REPEATS and now >= self.next_bump_send then
    self.next_bump_send = now + self.cfg.BUMP_REBROADCAST
    self.bump_sent = self.bump_sent + 1
    self:send_raw(splink.VERSION .. "K" .. self.sid ..
                  dec3(now - self.bump_at) .. hex2(self.bump_mag))
    self:try_pair()
    return
  end

  if self.tx then
    if now >= self.tx.deadline then
      self:log("tx_timeout")
      self.tx = nil
      self:emit("send_failed", splink.TIMEOUT)
    elseif now >= self.tx.next_at then
      if self.tx.tries >= self.cfg.DATA_TRIES then
        self.tx = nil
        self:emit("send_failed", splink.TIMEOUT)
      else
        self.tx.tries = self.tx.tries + 1
        self.tx.next_at = now + self.cfg.DATA_RETRY_MS
        self:send_raw(splink.VERSION .. "D" .. self.lid .. hex1(self.tx.seq) ..
                      hex1(self.tx.count) .. self.tx.parts[self.tx.seq])
        return
      end
    end
  end

  if self.state ~= splink.PAIRED and now >= self.next_beacon then
    self.next_beacon = now + self.cfg.BEACON_MS
    self:send_raw(splink.VERSION .. "H" .. self.role .. self.sid ..
                  (self.state == splink.ARMED and "1" or "0"))
  end
end

-- Telemetry for the calibration UI: the loudest armed peer we can currently see.
function Link:best_peer()
  local now = self.env.ms()
  local best = nil
  for _, p in pairs(self.peers) do
    if now - p.seen <= self.cfg.PEER_TTL then
      if not best or p.rssi > best.rssi then best = p end
    end
  end
  return best
end

return splink
