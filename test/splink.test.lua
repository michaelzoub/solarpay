-- Host tests for the SPL1 link layer. Run: lua test/splink.test.lua
--
-- A fake radio bus models the real one: every armed badge hears every frame,
-- frames can be dropped, and RSSI is set per badge pair. That is what makes
-- "who did I tap?" hard, so the tests are mostly about refusing the wrong peer.

package.path = "badges/lib/?.lua;" .. package.path
local splink = require("splink")

local passed, failed = 0, 0
local function check(name, ok, detail)
  if ok then
    passed = passed + 1
  else
    failed = failed + 1
    print("FAIL " .. name .. (detail and ("  -- " .. detail) or ""))
  end
end
local function eq(name, got, want)
  check(name, got == want, "got " .. tostring(got) .. ", want " .. tostring(want))
end

-- Fake world ----------------------------------------------------------------

local World = {}

function World.new()
  local w = { now = 0, badges = {}, rssi = {}, drop = 0, sent = 0 }

  function w.advance(ms, step)
    step = step or 20
    local target = w.now + ms
    while w.now < target do
      w.now = w.now + step
      if w.now > target then w.now = target end
      for _, b in ipairs(w.badges) do b.link:tick() end
    end
  end

  function w.add(name, role, seed, opts)
    local b = { name = name, mac = "AA:" .. name, events = {} }
    local counter = seed
    b.link = splink.new({
      ms = function() return w.now end,
      random = function(n) counter = (counter * 1103515245 + 12345) % 2147483648
                           return counter % n end,
      log = function(_) end,
      send = function(payload)
        w.sent = w.sent + 1
        for _, other in ipairs(w.badges) do
          if other ~= b then
            local key = b.name .. ">" .. other.name
            local rssi = w.rssi[key] or w.rssi[other.name .. ">" .. b.name] or -90
            if w.drop == 0 or (w.sent % w.drop) ~= 0 then
              other.link:on_frame(b.mac, rssi, payload)
            end
          end
        end
        return true
      end,
    }, opts and (function() local o = {} for k, v in pairs(opts) do o[k] = v end
                 o.role = role return o end)() or { role = role })
    for _, name2 in ipairs({ "paired", "message", "ambiguous", "sent",
                             "send_failed", "closed", "expired", "pair_failed" }) do
      b.link:on(name2, function(a) b.events[#b.events + 1] = { name2, a } end)
    end
    w.badges[#w.badges + 1] = b
    return b
  end

  function w.link(a, b, rssi) w.rssi[a.name .. ">" .. b.name] = rssi end

  function w.count(b, event)
    local n = 0
    for _, e in ipairs(b.events) do if e[1] == event then n = n + 1 end end
    return n
  end

  return w
end

-- Badges sit still at 1 g until something happens. Priming matters: the module
-- measures an impact as a deviation from the resting magnitude it has learned.
local function settle(w, ...)
  for _, b in ipairs({ ... }) do
    for _ = 1, 8 do b.link:feed_accel(0, 0, 1000, false) end
  end
end

-- A knock felt by both badges at (almost) the same instant.
local function knock(w, a, b, mg, skew_ms)
  settle(w, a, b)
  a.link:feed_accel(0, 0, 1000 + mg, true)
  if skew_ms and skew_ms > 0 then w.advance(skew_ms, skew_ms) end
  b.link:feed_accel(0, 0, 1000 + mg, true)
end

-- Primitives ----------------------------------------------------------------

eq("crc16 of empty is the CCITT-FALSE init", splink.crc16(""), 0xFFFF)
eq("crc16 of 123456789", splink.crc16("123456789"), 0x29B1)
eq("hex4 wraps", splink.hex4(65536 + 258), "0102")
eq("unhex round-trips", splink.unhex(splink.hex4(48879)), 48879)
eq("unhex rejects junk", splink.unhex("zz"), nil)

local sealed = splink.seal("SPL1HS12341")
eq("seal appends four hex chars", #sealed, #"SPL1HS12341" + 4)
eq("unseal accepts its own frame", splink.unseal(sealed), "SPL1HS12341")
eq("unseal rejects a flipped bit",
   splink.unseal("SPL1HS12340" .. string.sub(sealed, -4)), nil)
eq("unseal rejects a foreign prefix", splink.unseal("XXXXHS12341abcd"), nil)
eq("unseal rejects a short frame", splink.unseal("SPL1"), nil)
eq("both badges derive the same link id",
   splink.link_id("beef", "1234"), splink.link_id("1234", "beef"))

-- Happy path ----------------------------------------------------------------

do
  local w = World.new()
  local s = w.add("S", "S", 11)
  local m = w.add("M", "M", 22)
  w.link(s, m, -45)

  s.link:arm(); m.link:arm()
  w.advance(500)
  eq("no pairing before a bump", w.count(s, "paired"), 0)

  knock(w, s, m, 1200)
  w.advance(600)
  eq("sender paired after the bump", w.count(s, "paired"), 1)
  eq("merchant paired after the bump", w.count(m, "paired"), 1)
  eq("sender reached PAIRED", s.link.state, splink.PAIRED)
  eq("merchant reached PAIRED", m.link.state, splink.PAIRED)
  eq("both agree on the link id", s.link.lid, m.link.lid)

  local ok = m.link:send_message("SPI:0a1b2c3d:250000000:9f3a")
  check("merchant queued a message", ok)
  w.advance(1500)
  eq("sender received it", w.count(s, "message"), 1)
  local got
  for _, e in ipairs(s.events) do if e[1] == "message" then got = e[2] end end
  eq("payload survived fragmentation", got, "SPI:0a1b2c3d:250000000:9f3a")
  eq("merchant saw the send complete", w.count(m, "sent"), 1)
  check("merchant is no longer sending", not m.link:sending())
end

-- Refusals ------------------------------------------------------------------

do -- a badge across the room, knocked at the same moment
  local w = World.new()
  local s = w.add("S", "S", 31)
  local m = w.add("M", "M", 32)
  w.link(s, m, -88)
  s.link:arm(); m.link:arm()
  w.advance(500)
  knock(w, s, m, 1200)
  w.advance(800)
  eq("weak RSSI blocks pairing", w.count(s, "paired"), 0)
  eq("weak RSSI blocks pairing (peer)", w.count(m, "paired"), 0)
end

do -- close enough, but only one badge was knocked
  local w = World.new()
  local s = w.add("S", "S", 41)
  local m = w.add("M", "M", 42)
  w.link(s, m, -40)
  s.link:arm(); m.link:arm()
  w.advance(500)
  settle(w, s, m)
  s.link:feed_accel(0, 0, 2200, true)
  w.advance(800)
  eq("a one-sided knock does not pair", w.count(s, "paired"), 0)
  eq("a one-sided knock does not pair (peer)", w.count(m, "paired"), 0)
end

do -- both knocked, but far apart in time
  local w = World.new()
  local s = w.add("S", "S", 51)
  local m = w.add("M", "M", 52)
  w.link(s, m, -40)
  s.link:arm(); m.link:arm()
  w.advance(500)
  knock(w, s, m, 1200, 320)
  w.advance(800)
  eq("knocks 320 ms apart do not pair", w.count(s, "paired"), 0)
end

do -- close, simultaneous, but the peer never armed
  local w = World.new()
  local s = w.add("S", "S", 61)
  local m = w.add("M", "M", 62)
  w.link(s, m, -40)
  s.link:arm()
  w.advance(500)
  knock(w, s, m, 1200)
  w.advance(800)
  eq("an unarmed peer does not pair", w.count(s, "paired"), 0)
  eq("an unarmed peer stays idle", m.link.state, splink.IDLE)
end

do -- two merchants, both close, both knocked at the same instant
  local w = World.new()
  local s = w.add("S", "S", 71)
  local m1 = w.add("M1", "M", 72)
  local m2 = w.add("M2", "M", 73)
  w.link(s, m1, -40); w.link(s, m2, -42); w.link(m1, m2, -50)
  s.link:arm(); m1.link:arm(); m2.link:arm()
  w.advance(500)
  settle(w, s, m1, m2)
  s.link:feed_accel(0, 0, 2200, true)
  m1.link:feed_accel(0, 0, 2200, true)
  m2.link:feed_accel(0, 0, 2200, true)
  w.advance(800)
  eq("an ambiguous tap pairs with nobody", w.count(s, "paired"), 0)
  check("an ambiguous tap is reported", w.count(s, "ambiguous") > 0)
end

do -- two senders is not a pairing; roles must differ
  local w = World.new()
  local a = w.add("A", "S", 81)
  local b = w.add("B", "S", 82)
  w.link(a, b, -40)
  a.link:arm(); b.link:arm()
  w.advance(500)
  knock(w, a, b, 1200)
  w.advance(800)
  eq("two senders do not pair", w.count(a, "paired"), 0)
end

do -- a knock with very different force on each side
  local w = World.new()
  local s = w.add("S", "S", 91)
  local m = w.add("M", "M", 92)
  w.link(s, m, -40)
  s.link:arm(); m.link:arm()
  w.advance(500)
  settle(w, s, m)
  s.link:feed_accel(0, 0, 6000, true)   -- a hard whack: ~5 g over rest
  m.link:feed_accel(0, 0, 1400, true)   -- a light nudge: ~0.4 g over rest
  w.advance(800)
  eq("mismatched impact strength does not pair", w.count(s, "paired"), 0)
end

do -- a bystander that is close and armed but was never knocked
  local w = World.new()
  local s = w.add("S", "S", 201)
  local m = w.add("M", "M", 202)
  local x = w.add("X", "M", 203)
  w.link(s, m, -40); w.link(s, x, -38); w.link(m, x, -40)
  s.link:arm(); m.link:arm(); x.link:arm()
  w.advance(500)
  knock(w, s, m, 1200)
  w.advance(900)
  eq("the bystander is not the counterparty", w.count(x, "paired"), 0)
  eq("the two knocked badges pair with each other", w.count(s, "paired"), 1)
  eq("the sender chose the badge it was knocked against",
     s.link:paired_peer().sid, m.link.sid)
end

do -- a corrupted frame is ignored rather than half-parsed
  local w = World.new()
  local s = w.add("S", "S", 211)
  w.add("M", "M", 212)
  s.link:arm()
  local before = s.link.state
  eq("a frame with a bad crc changes nothing",
     s.link:on_frame("AA:M", -30, "SPL1HM9999" .. "1" .. "0000"), false)
  eq("state is untouched by a bad frame", s.link.state, before)
  eq("a truncated frame is ignored", s.link:on_frame("AA:M", -30, "SPL1H"), false)
  eq("a non-SPL1 frame is ignored",
     s.link:on_frame("AA:M", -30, "SP2:P:M:abcdef"), false)
end

do -- re-arming starts a genuinely fresh session
  local w = World.new()
  local s = w.add("S", "S", 221)
  local m = w.add("M", "M", 222)
  w.link(s, m, -40)
  s.link:arm(); m.link:arm()
  w.advance(500)
  knock(w, s, m, 1200)
  w.advance(900)
  local first = s.link.sid
  eq("paired once", w.count(s, "paired"), 1)
  s.link:disarm(splink.OK)
  local second = s.link:arm()
  check("re-arming issues a new session id", first ~= second)
  eq("re-arming clears the old peer", s.link:paired_peer(), nil)
  eq("re-arming clears the old link id", s.link.lid, nil)
end

-- Robustness ----------------------------------------------------------------

do -- one frame in three is lost
  local w = World.new()
  local s = w.add("S", "S", 101)
  local m = w.add("M", "M", 102)
  w.link(s, m, -40)
  w.drop = 3
  s.link:arm(); m.link:arm()
  w.advance(500)
  knock(w, s, m, 1200)
  w.advance(1200)
  eq("pairing survives a lossy channel", w.count(s, "paired"), 1)
  m.link:send_message("SPI:0a1b2c3d:250000000:9f3a:extra-padding-here")
  w.advance(3000)
  eq("retries deliver the message anyway", w.count(s, "message"), 1)
end

do -- the peer vanishes mid-message
  local w = World.new()
  local s = w.add("S", "S", 111)
  local m = w.add("M", "M", 112)
  w.link(s, m, -40)
  s.link:arm(); m.link:arm()
  w.advance(500)
  knock(w, s, m, 1200)
  w.advance(600)
  eq("paired before the peer leaves", w.count(m, "paired"), 1)
  s.link:disarm(splink.CANCELLED)
  m.link:send_message("SPI:0a1b2c3d:250000000:9f3a")
  w.advance(4000)
  check("a lost peer fails the send rather than hanging",
        w.count(m, "send_failed") == 1 or w.count(m, "closed") == 1)
end

do -- an arm that nobody answers falls back to idle
  local w = World.new()
  local s = w.add("S", "S", 121, { ARM_MS = 1000 })
  w.add("M", "M", 122)
  s.link:arm()
  w.advance(1400)
  eq("an unanswered arm expires", s.link.state, splink.IDLE)
  eq("expiry is reported once", w.count(s, "expired"), 1)
end

do -- cancelling tells the peer
  local w = World.new()
  local s = w.add("S", "S", 131)
  local m = w.add("M", "M", 132)
  w.link(s, m, -40)
  s.link:arm(); m.link:arm()
  w.advance(500)
  knock(w, s, m, 1200)
  w.advance(600)
  s.link:disarm(splink.CANCELLED)
  w.advance(100)
  eq("the peer is told about the cancel", w.count(m, "closed"), 1)
  eq("the peer returns to idle", m.link.state, splink.IDLE)
end

do -- a second tap while already paired must not re-pair
  local w = World.new()
  local s = w.add("S", "S", 141)
  local m = w.add("M", "M", 142)
  w.link(s, m, -40)
  s.link:arm(); m.link:arm()
  w.advance(500)
  knock(w, s, m, 1200)
  w.advance(600)
  knock(w, s, m, 1200)
  w.advance(600)
  eq("a paired link does not pair again", w.count(s, "paired"), 1)
end

-- Frame budget --------------------------------------------------------------

do
  local w = World.new()
  local longest = 0
  local s = w.add("S", "S", 151)
  local m = w.add("M", "M", 152)
  w.link(s, m, -40)
  local inner = s.link.env.send
  s.link.env.send = function(p) if #p > longest then longest = #p end return inner(p) end
  local inner2 = m.link.env.send
  m.link.env.send = function(p) if #p > longest then longest = #p end return inner2(p) end
  s.link:arm(); m.link:arm()
  w.advance(400)
  knock(w, s, m, 1200)
  w.advance(600)
  m.link:send_message(string.rep("x", 90))
  w.advance(3000)
  check("every frame fits the 44-byte radio limit", longest <= 44,
        "longest was " .. longest)
  eq("a 90-byte message arrives whole",
     (function() for _, e in ipairs(s.events) do
        if e[1] == "message" then return #e[2] end end return -1 end)(), 90)
end

print(string.format("%d passed, %d failed", passed, failed))
os.exit(failed == 0 and 0 or 1)
