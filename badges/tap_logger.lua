--[==[badge-app
slug=solarpay_tap_logger
name=SolarPay Touch Test
icon=TAP
api=2
heap_kb=48
wake_lock=1
version=0.2.0
]==]

-- Diagnostic companion. Install on two badges and open it on both.
-- Physical badge contact is sensed with motion; radio identifies the peer.
-- A passive NFC card/tag is still detected through the NFC reader.

local nfc_ok, radio_ok = false, false
local local_id, peer_id, peer_mac, peer_rssi = "UNLINKED", nil, nil, nil
local peer_seen_at, next_beacon, next_nfc_poll = 0, 0, 0
local last_uid, last_uid_at, seq, count = nil, 0, 0, 0
local status, detail, counter

local function emit(event, fields)
  seq = seq + 1
  local line = "SP_EVT|v=2|seq=" .. seq .. "|role=touch_test|type=" .. event
  if fields and fields ~= "" then line = line .. "|" .. fields end
  badge.sys.log(line)
end

local function peer_near(now)
  return peer_mac and now - peer_seen_at < 1600
end

local function show_waiting()
  status:set_text("BUMP TWO BADGES")
  detail:set_text("Open this test on both badges")
end

local function show_touch(method, identity)
  count = count + 1
  status:set_text("TOUCH EVENT")
  detail:set_text(method .. " / " .. identity)
  counter:set_text("Events: " .. count)
  badge.led.set_all(0, 230, 80)
  badge.led.show()
end

function on_enter(root)
  local_id = badge.me.badge_id() or "UNLINKED"
  local title = badge.ui.label(root, "SolarPay Touch Test")
  title:align("top_mid", 0, 14)
  status = badge.ui.label(root, "STARTING...")
  status:align("center", 0, -28)
  detail = badge.ui.label(root, "Motion + nearby radio peer")
  detail:style({text_font = 14})
  detail:align("center", 0, 7)
  counter = badge.ui.label(root, "Events: 0")
  counter:style({text_font = 14})
  counter:align("center", 0, 38)
  local hint = badge.ui.label(root, "A reset   HOME exit")
  hint:style({text_font = 14})
  hint:align("bottom_mid", 0, -14)

  emit("app_enter", "badge_id=" .. local_id)
  nfc_ok = badge.nfc.enable()
  if nfc_ok then badge.nfc.clear(); emit("nfc_ready") else emit("nfc_unavailable") end

  radio_ok = badge.radio.enable()
  if radio_ok then
    emit("radio_ready", "mac=" .. badge.radio.mac())
    badge.radio.on_recv(function(mac, rssi, payload)
      if mac == badge.radio.mac() or type(payload) ~= "string" then return end
      if string.sub(payload, 1, 6) ~= "SPT:P:" then return end
      local changed = peer_mac ~= mac
      peer_mac, peer_id, peer_rssi, peer_seen_at = mac, string.sub(payload, 7), rssi, badge.sys.ms()
      if changed then emit("peer_seen", "peer_badge_id=" .. peer_id .. "|peer_mac=" .. mac .. "|rssi=" .. rssi) end
    end)
  else emit("radio_unavailable") end
  show_waiting()
end

function on_tick()
  local now = badge.sys.ms()
  if radio_ok and now >= next_beacon then
    next_beacon = now + 500
    badge.radio.send("SPT:P:" .. string.sub(local_id, 1, 34))
  end

  if badge.sensor.tap() then
    emit("motion_tap", "peer_near=" .. (peer_near(now) and "1" or "0") .. "|uptime_ms=" .. now)
    if peer_near(now) then
      show_touch("BADGE", peer_id or peer_mac)
      emit("badge_touch", "local_badge_id=" .. local_id .. "|peer_badge_id=" .. tostring(peer_id) ..
        "|peer_mac=" .. peer_mac .. "|rssi=" .. tostring(peer_rssi) .. "|count=" .. count)
    else
      status:set_text("TAP - NO PEER")
      detail:set_text("Bring another test badge closer")
      emit("touch_unpaired", "reason=no_recent_peer")
    end
  end

  if not nfc_ok or now < next_nfc_poll then return end
  next_nfc_poll = now + 200
  local card = badge.nfc.card()
  if not card or not card.uid or card.uid == "" then return end
  if card.uid == last_uid and now - last_uid_at < 2000 then return end
  last_uid, last_uid_at = card.uid, now
  show_touch("NFC", card.uid)
  emit("nfc_tap", "local_badge_id=" .. local_id .. "|peer_uid=" .. card.uid ..
    "|sak=" .. tostring(card.sak) .. "|atqa=" .. tostring(card.atqa) .. "|count=" .. count)
  badge.nfc.clear()
end

function on_button(button, kind)
  emit("button", "button=" .. tostring(button) .. "|kind=" .. tostring(kind))
  if kind == badge.input.KIND.PRESSED and button == badge.input.BUTTON.A then
    if nfc_ok then badge.nfc.clear() end
    last_uid, last_uid_at = nil, 0
    show_waiting()
    emit("scanner_rearmed", "source=button_a")
  end
end

function on_exit()
  emit("app_exit", "event_count=" .. count)
  if nfc_ok then badge.nfc.disable() end
  if radio_ok then badge.radio.on_recv(nil); badge.radio.disable() end
  badge.led.clear()
  badge.led.show()
end
