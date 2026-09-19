--[==[badge-app
slug=solarpay_terminal
name=SolarPay Terminal
icon=PAY
api=2
heap_kb=48
wake_lock=1
version=0.3.0
]==]

local profile_badge_id = "__SOLARPAY_BADGE_ID__"
local wallet_address = "__SOLARPAY_WALLET_ADDRESS__"

-- Radio hardware demo. A broadcasts a test payment. Approvals are logged to
-- USB serial for the laptop to observe. The documented badge API has no USB RX.
local radio_ok = false
local active_id, active_nonce = nil, nil
local expires_at = 0
local status, detail
local event_seq = 0
local last_dropped = 0
local beacon_seq, next_beacon = 0, 0
local proximity_rssi, proximity_zone, proximity_mac = nil, nil, nil
local proximity_seen_at, next_proximity_log = 0, 0

local function emit_event(event, fields)
  event_seq = event_seq + 1
  local line = "SP_EVT|v=1|seq=" .. event_seq .. "|role=merchant|type=" .. event
  if fields and fields ~= "" then line = line .. "|" .. fields end
  badge.sys.log(line)
end

local function button_name(button)
  local B = badge.input.BUTTON
  if button == B.A then return "A" end
  if button == B.B then return "B" end
  if button == B.HOME then return "HOME" end
  if button == B.DOWN then return "DOWN" end
  if button == B.LEFT then return "LEFT" end
  if button == B.RIGHT then return "RIGHT" end
  if button == B.UP then return "UP" end
  if button == B.AUX1 then return "AUX1" end
  if button == B.START then return "START" end
  return tostring(button)
end

local function rssi_zone(rssi)
  if rssi >= -55 then return "very_close" end
  if rssi >= -68 then return "close" end
  if rssi >= -80 then return "nearby" end
  return "far"
end

local function observe_proximity(mac, rssi)
  local now = badge.sys.ms()
  if proximity_mac ~= mac or not proximity_rssi then
    proximity_mac, proximity_rssi = mac, rssi
  else
    proximity_rssi = math.floor((proximity_rssi * 3 + rssi) / 4)
  end
  proximity_seen_at = now
  local zone = rssi_zone(proximity_rssi)
  if zone ~= proximity_zone or now >= next_proximity_log then
    proximity_zone = zone
    next_proximity_log = now + 1000
    emit_event("proximity", "peer=" .. tostring(mac) .. "|rssi=" .. proximity_rssi .. "|zone=" .. zone)
  end
end

local function set_leds(r, g, b)
  badge.led.clear()
  for i = 1, 6 do badge.led.set(i, r, g, b) end
  badge.led.show()
end

local function broadcast_test()
  active_id = string.format("%08x", badge.sys.random())
  active_nonce = string.sub(string.format("%08x%08x", badge.sys.random(), badge.sys.random()), 1, 11)
  expires_at = badge.sys.ms() + 90000
  local packet = "SP1:I:" .. active_id .. ":10000000:90:" .. active_nonce .. ":SH"
  emit_event("broadcast_requested", "intent=" .. active_id .. "|lamports=10000000")
  if badge.radio.send(packet) then
    status:set_text("Payment broadcast")
    detail:set_text("0.0100 SOL  •  " .. active_id)
    set_leds(20, 110, 62)
    emit_event("broadcast_queued", "intent=" .. active_id .. "|bytes=" .. #packet)
  else
    status:set_text("Broadcast failed")
    set_leds(130, 20, 10)
    emit_event("broadcast_failed", "intent=" .. active_id)
  end
end

function on_enter(root)
  local linked_id = profile_badge_id
  if string.sub(linked_id, 1, 2) == "__" then linked_id = badge.me.badge_id() or "unprovisioned" end
  badge.sys.log("SOLARPAY_BADGE:merchant:" .. linked_id)
  emit_event("app_enter", "badge_id=" .. linked_id)
  local title = badge.ui.label(root, "SolarPay Terminal")
  title:align("top_mid", 0, 18)
  status = badge.ui.label(root, "Starting radio...")
  status:align("center", 0, -22)
  detail = badge.ui.label(root, "A sends a test payment")
  detail:style({text_font = 14})
  detail:align("center", 0, 12)
  local hint = badge.ui.label(root, "A broadcast   B cancel   HOME exit")
  hint:style({text_font = 14})
  hint:align("bottom_mid", 0, -18)
  radio_ok = badge.radio.enable()
  if not radio_ok then
    emit_event("radio_unavailable")
    status:set_text("Radio unavailable"); set_leds(120, 20, 10); return
  end
  status:set_text("Ready")
  set_leds(0, 35, 18)
  emit_event("radio_ready", "mac=" .. tostring(badge.radio.mac()))
  badge.radio.on_recv(function(mac, rssi, payload)
    if string.sub(payload, 1, 4) ~= "SP1:" then return end
    if string.match(payload, "^SP1:P:C:%d+$") then observe_proximity(mac, rssi); return end
    emit_event("radio_received", "mac=" .. tostring(mac) .. "|rssi=" .. tostring(rssi) .. "|bytes=" .. #payload)
    if not active_id then emit_event("approval_ignored", "reason=no_active_intent"); return end
    if badge.sys.ms() >= expires_at then emit_event("approval_ignored", "reason=intent_expired|intent=" .. active_id); return end
    local prefix = "SP1:A:" .. active_id .. ":"
    if string.sub(payload, 1, #prefix) ~= prefix then emit_event("approval_ignored", "reason=intent_mismatch|intent=" .. active_id); return end
    status:set_text("Customer approved")
    detail:set_text("Relayed to laptop over serial")
    badge.sys.log("SOLARPAY_APPROVAL:" .. payload)
    emit_event("approval_received", "intent=" .. active_id .. "|bytes=" .. #payload)
    set_leds(0, 180, 75)
    active_id = nil; active_nonce = nil
  end)
end

function on_tick()
  if radio_ok then
    local now = badge.sys.ms()
    if now >= next_beacon then
      next_beacon = now + 750
      beacon_seq = (beacon_seq + 1) % 10000
      badge.radio.send("SP1:P:T:" .. beacon_seq)
    end
    if proximity_zone and now - proximity_seen_at > 3000 then
      emit_event("proximity_lost", "peer=" .. tostring(proximity_mac))
      proximity_rssi, proximity_zone, proximity_mac = nil, nil, nil
    end
    local dropped = badge.radio.dropped()
    if dropped ~= last_dropped then
      last_dropped = dropped
      emit_event("radio_dropped", "count=" .. dropped)
    end
  end
  if active_id and badge.sys.ms() >= expires_at then
    local expired_id = active_id
    active_id = nil; active_nonce = nil
    status:set_text("Payment expired")
    detail:set_text("Press A to try again")
    set_leds(100, 45, 0)
    emit_event("intent_expired", "intent=" .. expired_id)
  end
end

function on_button(button, kind)
  emit_event("button", "button=" .. button_name(button) .. "|kind=" .. (kind == badge.input.KIND.PRESSED and "pressed" or "released"))
  if kind ~= badge.input.KIND.PRESSED then return end
  if not radio_ok then emit_event("button_ignored", "reason=radio_unavailable|button=" .. button_name(button)); return end
  if button == badge.input.BUTTON.A then broadcast_test() end
  if button == badge.input.BUTTON.B then
    local cancelled_id = active_id
    active_id = nil; active_nonce = nil; status:set_text("Cancelled"); detail:set_text("Press A for a new payment"); set_leds(0, 35, 18)
    emit_event("intent_cancelled", cancelled_id and ("intent=" .. cancelled_id) or "intent=none")
  end
end

function on_exit()
  emit_event("app_exit", "radio=" .. (radio_ok and "enabled" or "disabled"))
  badge.led.clear(); badge.led.show()
  if radio_ok then badge.radio.on_recv(nil); badge.radio.disable() end
end
