--[==[badge-app
slug=solarpay_customer
name=SolarPay Customer
icon=SOL
api=2
heap_kb=48
wake_lock=1
version=0.3.0
]==]

local profile_badge_id = "__SOLARPAY_BADGE_ID__"
local wallet_address = "__SOLARPAY_WALLET_ADDRESS__"
local radio_ok = false
local pending_id, pending_nonce, pending_amount, deadline
local status, amount, hint, wallet
local event_seq = 0
local last_dropped = 0
local beacon_seq, next_beacon = 0, 0
local proximity_rssi, proximity_zone, proximity_mac = nil, nil, nil
local proximity_seen_at, next_proximity_log = 0, 0

local function emit_event(event, fields)
  event_seq = event_seq + 1
  local line = "SP_EVT|v=1|seq=" .. event_seq .. "|role=customer|type=" .. event
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

local function short_address(value)
  if not value or #value < 18 or string.sub(value, 1, 2) == "__" then return "Profile not linked" end
  return string.sub(value, 1, 8) .. "..." .. string.sub(value, -8)
end

local function set_leds(r, g, b)
  badge.led.clear()
  for i = 1, 6 do badge.led.set(i, r, g, b) end
  badge.led.show()
end

function on_enter(root)
  local linked_id = profile_badge_id
  if string.sub(linked_id, 1, 2) == "__" then linked_id = badge.me.badge_id() or "unprovisioned" end
  badge.sys.log("SOLARPAY_BADGE:customer:" .. linked_id)
  emit_event("app_enter", "badge_id=" .. linked_id)
  local title = badge.ui.label(root, "SolarPay")
  title:align("top_mid", 0, 18)
  wallet = badge.ui.label(root, short_address(wallet_address))
  wallet:style({text_font = 14})
  wallet:align("top_mid", 0, 46)
  status = badge.ui.label(root, "Looking for a terminal...")
  status:style({text_font = 14})
  status:align("center", 0, -34)
  amount = badge.ui.label(root, "No payment")
  amount:align("center", 0, 0)
  hint = badge.ui.label(root, "HOME exit")
  hint:style({text_font = 14})
  hint:align("bottom_mid", 0, -18)
  radio_ok = badge.radio.enable()
  if not radio_ok then
    emit_event("radio_unavailable")
    status:set_text("Radio unavailable"); set_leds(120, 20, 10); return
  end
  emit_event("radio_ready", "mac=" .. tostring(badge.radio.mac()))
  set_leds(0, 22, 14)
  badge.radio.on_recv(function(mac, rssi, payload)
    if string.sub(payload, 1, 4) ~= "SP1:" then return end
    if string.match(payload, "^SP1:P:T:%d+$") then observe_proximity(mac, rssi); return end
    emit_event("radio_received", "mac=" .. tostring(mac) .. "|rssi=" .. tostring(rssi) .. "|bytes=" .. #payload)
    local id, lamports, ttl, nonce, merchant = string.match(payload, "^SP1:I:([0-9a-f]+):(%d+):(%d+):([0-9a-f]+):([A-Za-z0-9_-]+)$")
    if not id then emit_event("intent_rejected", "reason=invalid_format"); return end
    pending_id = id
    pending_nonce = nonce
    pending_amount = tonumber(lamports)
    deadline = badge.sys.ms() + math.min(tonumber(ttl), 90) * 1000
    status:set_text("Merchant " .. merchant .. " requests")
    amount:set_text(string.format("%.4f SOL", pending_amount / 1000000000))
    hint:set_text("A approve   B decline   HOME exit")
    set_leds(18, 105, 60)
    emit_event("intent_received", "intent=" .. id .. "|lamports=" .. lamports .. "|ttl=" .. ttl .. "|merchant=" .. merchant)
  end)
end

function on_tick()
  if radio_ok then
    local now = badge.sys.ms()
    if now >= next_beacon then
      next_beacon = now + 750
      beacon_seq = (beacon_seq + 1) % 10000
      badge.radio.send("SP1:P:C:" .. beacon_seq)
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
  if pending_id and badge.sys.ms() >= deadline then
    local expired_id = pending_id
    pending_id = nil; pending_nonce = nil
    status:set_text("Payment expired")
    amount:set_text("No payment")
    hint:set_text("HOME exit")
    set_leds(90, 45, 0)
    emit_event("intent_expired", "intent=" .. expired_id)
  end
end

function on_button(button, kind)
  emit_event("button", "button=" .. button_name(button) .. "|kind=" .. (kind == badge.input.KIND.PRESSED and "pressed" or "released"))
  if kind ~= badge.input.KIND.PRESSED or not pending_id then return end
  if button == badge.input.BUTTON.B then
    local declined_id = pending_id
    pending_id = nil; pending_nonce = nil; status:set_text("Declined"); amount:set_text("No payment"); hint:set_text("HOME exit"); set_leds(70, 15, 10)
    emit_event("intent_declined", "intent=" .. declined_id)
    return
  end
  if button ~= badge.input.BUTTON.A then return end
  local id = profile_badge_id
  if string.sub(id, 1, 2) == "__" then id = badge.me.badge_id() end
  if not id or #id > 16 then status:set_text("Badge ID unavailable"); emit_event("approval_rejected", "reason=badge_id_unavailable"); return end
  local packet = "SP1:A:" .. pending_id .. ":" .. id .. ":" .. pending_nonce
  if #packet > 44 then status:set_text("Badge ID too long"); emit_event("approval_rejected", "reason=packet_too_long"); return end
  if badge.radio.send(packet) then
    local approved_id = pending_id
    status:set_text("Approval sent")
    amount:set_text("Waiting for terminal")
    hint:set_text("HOME exit")
    set_leds(0, 180, 75)
    pending_id = nil; pending_nonce = nil
    emit_event("approval_queued", "intent=" .. approved_id .. "|bytes=" .. #packet)
  else
    status:set_text("Send failed - press A")
    emit_event("approval_send_failed", "intent=" .. pending_id)
  end
end

function on_exit()
  emit_event("app_exit", "radio=" .. (radio_ok and "enabled" or "disabled"))
  badge.led.clear(); badge.led.show()
  if radio_ok then badge.radio.on_recv(nil); badge.radio.disable() end
end
