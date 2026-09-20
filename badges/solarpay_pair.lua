--[==[badge-app
slug=solarpay_pair
name=SolarPay Link Test
icon=LNK
api=2
heap_kb=96
wake_lock=1
version=1.0.0
]==]
-- Two-badge pairing proof of concept. No payments, no wallet, no backend: this
-- app exists to answer one question on real hardware -- can two badges decide
-- they were deliberately tapped together, and refuse every other badge in the
-- room?
--
-- Install on two badges. Set one to SENDER and one to MERCHANT with UP, press A
-- on both to arm, hold them together and knock them once. Both should show
-- PAIRED with the other badge's session id.
--
-- The live RSSI readout is the calibration tool: hold the badges at the
-- distance you consider a deliberate tap, read the smoothed RSSI, and set
-- RSSI_GATE just below it.

--#include lib/splink.lua

local link, role = nil, "S"
local title, state_lbl, peer_lbl, rssi_lbl, hint_lbl, bar, bar_fill, foot
local seq, pairs_ok, refusals = 0, 0, 0
local flash_until, flash_color = 0, 0
local next_led, next_paint = 0, 0
local last_event = "ready"

local C = { ink = 0x10091F, panel = 0x21143D, purple = 0x9A5CFF, pink = 0xFF4FD8,
            cyan = 0x4DEBFF, green = 0x55F991, yellow = 0xFFE45E, red = 0xFF304F,
            white = 0xFFF8FF, soft = 0xC5AFDD, dim = 0x806B9A }

local function emit(kind, fields)
  seq = seq + 1
  badge.sys.log("SP_EVT|v=4|seq=" .. seq .. "|role=pair_test|type=" .. kind ..
                (fields and ("|" .. fields) or ""))
end

local function flash(color, ms)
  flash_until, flash_color = badge.sys.ms() + (ms or 900), color
end

-- RSSI as a 0..100 bar so the gate is something you can see, not a number you
-- have to remember. -30 dBm reads full, the gate sits at the marked notch.
local function rssi_pct(rssi)
  if not rssi then return 0 end
  local pct = math.floor((rssi + 95) * 100 / 65)
  if pct < 0 then pct = 0 elseif pct > 100 then pct = 100 end
  return pct
end

local function paint()
  local now = badge.sys.ms()
  local st = link and link.state or splink.IDLE
  local peer = link and (link:paired_peer() or link:best_peer()) or nil
  local rssi = peer and peer.rssi or nil
  local gate = splink.DEFAULTS.RSSI_GATE

  if st == splink.PAIRED then
    state_lbl:set_text("PAIRED"); state_lbl:set_color(C.green)
  elseif st == splink.PAIRING then
    state_lbl:set_text("PAIRING"); state_lbl:set_color(C.yellow)
  elseif st == splink.ARMED then
    state_lbl:set_text("ARMED"); state_lbl:set_color(C.cyan)
  else
    state_lbl:set_text("IDLE"); state_lbl:set_color(C.dim)
  end

  title:set_text("LINK TEST  ·  " .. (role == "S" and "SENDER" or "MERCHANT") ..
                 "  ·  " .. (link and link.sid or "----"))

  if st == splink.PAIRED then
    peer_lbl:set_text("PEER " .. peer.sid .. "   LINK " .. link.lid)
    peer_lbl:set_color(C.green)
  elseif peer then
    peer_lbl:set_text("SEES " .. (peer.sid or "????") .. "   " ..
                      (rssi >= gate and "IN RANGE - KNOCK" or "TOO FAR"))
    peer_lbl:set_color(rssi >= gate and C.cyan or C.soft)
  else
    peer_lbl:set_text(st == splink.IDLE and "PRESS A TO ARM" or "NO BADGE NEARBY")
    peer_lbl:set_color(C.soft)
  end

  rssi_lbl:set_text((rssi and (rssi .. " dBm") or "-- dBm") ..
                    "   gate " .. gate .. "   ok " .. pairs_ok ..
                    "   refused " .. refusals)
  bar_fill:set_size(math.floor(2.76 * rssi_pct(rssi)) + 1, 14)
  bar_fill:set_color(rssi and rssi >= gate and C.green or C.purple)
  hint_lbl:set_text(last_event)

  if st == splink.PAIRED then
    foot:set_text("B UNPAIR   HOME EXIT")
  elseif st == splink.IDLE then
    foot:set_text("A ARM   UP ROLE   HOME EXIT")
  else
    foot:set_text("B CANCEL   HOME EXIT")
  end
end

local function render_leds(now)
  badge.led.clear()
  if now < flash_until then
    local on = math.floor((flash_until - now) / 120) % 2 == 0
    if on then
      badge.led.set_all((flash_color >> 16) & 255, (flash_color >> 8) & 255, flash_color & 255)
    end
  elseif not link or link.state == splink.IDLE then
    badge.led.set_all(12, 6, 24)
  elseif link.state == splink.PAIRED then
    badge.led.set_all(0, 140, 60)
  else
    local peer = link:best_peer()
    if peer and peer.rssi >= splink.DEFAULTS.RSSI_GATE then
      local level = 90 + math.floor((now % 700) / 700 * 160)
      badge.led.set_all(0, level, level)
    else
      local level = 40 + math.floor((now % 1600) / 1600 * 90)
      badge.led.set_all(level, math.floor(level * 0.6), 0)
    end
  end
  badge.led.show()
end

function on_enter(root)
  local shell = badge.ui.box(root, 320, 240)
  shell:style({ bg_color = C.ink, radius = 0, border_width = 0 })

  title = badge.ui.label(shell, "LINK TEST")
  title:style({ text_color = C.soft, text_font = 14 }); title:align("top_mid", 0, 8)

  state_lbl = badge.ui.label(shell, "IDLE")
  state_lbl:style({ text_color = C.dim, text_font = 24 }); state_lbl:align("top_mid", 0, 34)

  peer_lbl = badge.ui.label(shell, "PRESS A TO ARM")
  peer_lbl:style({ text_color = C.soft, text_font = 14 }); peer_lbl:align("top_mid", 0, 72)

  bar = badge.ui.box(shell, 280, 18)
  bar:style({ bg_color = C.panel, radius = 0, border_color = C.purple, border_width = 2 })
  bar:align("top_mid", 0, 98)
  bar_fill = badge.ui.box(bar, 1, 14)
  bar_fill:style({ bg_color = C.purple, radius = 0, border_width = 0 })
  bar_fill:align("top_left", 0, 0)

  rssi_lbl = badge.ui.label(shell, "-- dBm")
  rssi_lbl:style({ text_color = C.soft, text_font = 14 }); rssi_lbl:align("top_mid", 0, 124)

  hint_lbl = badge.ui.label(shell, "ready")
  hint_lbl:style({ text_color = C.yellow, text_font = 14 }); hint_lbl:align("top_mid", 0, 152)

  foot = badge.ui.label(shell, "A ARM   UP ROLE   HOME EXIT")
  foot:style({ text_color = C.dim, text_font = 14 }); foot:align("bottom_mid", 0, -6)

  emit("app_enter", "badge_id=" .. (badge.me.badge_id() or "UNLINKED"))

  if not badge.radio.enable() then
    last_event = "RADIO UNAVAILABLE - REBOOT"
    emit("radio_unavailable")
    paint()
    return
  end
  emit("radio_ready", "mac=" .. badge.radio.mac())

  link = splink.new({
    ms = function() return badge.sys.ms() end,
    send = function(payload) return badge.radio.send(payload) end,
    random = function(n) return badge.sys.random(n) end,
    log = function(line) badge.sys.log(line) end,
  }, { role = role })

  -- Hand every received frame to the link layer. Keep this callback short: it
  -- runs inside the shared tick budget alongside drawing.
  badge.radio.on_recv(function(mac, rssi, payload)
    if type(payload) ~= "string" then return end
    if mac == badge.radio.mac() then return end
    link:on_frame(mac, rssi, payload)
  end)

  link:on("paired", function(peer)
    pairs_ok = pairs_ok + 1
    last_event = "PAIRED WITH " .. peer.sid
    flash(0x00FF5A, 1200)
    emit("paired", "peer=" .. peer.sid .. "|rssi=" .. peer.rssi .. "|lid=" .. link.lid)
    -- Prove the link carries data, not just a handshake.
    link:send_message("HELLO FROM " .. (badge.me.badge_id() or "UNLINKED"))
  end)
  link:on("ambiguous", function(count)
    refusals = refusals + 1
    last_event = "REFUSED - " .. count .. " BADGES KNOCKED"
    flash(0xFF304F, 900)
    emit("refused", "reason=ambiguous|count=" .. count)
  end)
  link:on("impact", function(mag)
    last_event = "KNOCK FELT (" .. mag .. ")"
    emit("impact", "mag=" .. mag)
  end)
  link:on("message", function(text)
    last_event = "GOT: " .. string.sub(text, 1, 26)
    emit("message", "len=" .. #text)
  end)
  link:on("sent", function() emit("message_acked") end)
  link:on("send_failed", function(code) emit("message_failed", "code=" .. code) end)
  link:on("pair_failed", function(code)
    refusals = refusals + 1
    last_event = "HANDSHAKE TIMED OUT"
    emit("pair_failed", "code=" .. code)
  end)
  link:on("closed", function(code)
    last_event = "PEER LEFT"
    emit("closed", "code=" .. code)
  end)
  link:on("expired", function()
    last_event = "ARM WINDOW CLOSED"
    emit("arm_expired")
  end)

  paint()
end

function on_tick()
  if not link then return end
  local now = badge.sys.ms()
  -- Feed motion every tick: the module needs the resting magnitude before it
  -- can measure a knock against it.
  local x, y, z = badge.sensor.accel()
  link:feed_accel(x, y, z, badge.sensor.tap())
  link:tick()
  if now >= next_led then next_led = now + 80; render_leds(now) end
  if now >= next_paint then next_paint = now + 150; paint() end
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED or not link then return end
  local B = badge.input.BUTTON
  if button == B.A then
    if link.state == splink.IDLE then
      link:arm()
      last_event = "ARMED - KNOCK THE BADGES TOGETHER"
      emit("armed", "sid=" .. link.sid .. "|role=" .. role)
    end
  elseif button == B.B then
    link:disarm(splink.CANCELLED)
    last_event = "cancelled"
    emit("cancelled")
  elseif button == B.UP then
    if link.state == splink.IDLE then
      role = role == "S" and "M" or "S"
      link.role = role
      emit("role_changed", "role=" .. role)
    end
  end
  paint()
end

function on_exit()
  emit("app_exit", "pairs=" .. pairs_ok .. "|refusals=" .. refusals)
  if link then link:disarm(splink.CANCELLED) end
  badge.radio.on_recv(nil)
  badge.radio.disable()
  badge.led.clear()
  badge.led.show()
end
