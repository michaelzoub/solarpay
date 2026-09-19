-- SolarPay NFC badge scanner.
-- A scans again. Present another badge to read its UID.
local enabled = false
local mode = "receive"
local screen = "waiting"
local last_uid = nil
local next_poll = 0
local title
local status
local detail

local function leds(red, green, blue)
  badge.led.clear()
  badge.led.set_all(red, green, blue)
  badge.led.show()
end

local function show_waiting()
  screen = "waiting"
  status:set_text(enabled and (mode == "receive" and "READY TO RECEIVE" or "READY TO SEND") or "NFC UNAVAILABLE")
  detail:set_text(enabled and "BUMP BADGE   A SCAN   B MODE" or "CHECK BADGE NFC")
  if mode == "receive" then
    leds(0, 0, 40)
  else
    leds(40, 20, 0)
  end
end

local function show_result(success, message)
  screen = success and "success" or "failure"
  status:set_text(success and "TRANSACTION SUCCESS" or "TRANSACTION FAILED")
  detail:set_text(message)
  if success then
    leds(0, 180, 0)
  else
    leds(180, 0, 0)
  end
end

function on_enter(root)
  title = badge.ui.label(root, "SOLARPAY / NFC")
  title:align("top_mid", 0, 16)

  status = badge.ui.label(root, "STARTING NFC...")
  status:set_font_size("large")
  status:align("center", 0, -20)

  detail = badge.ui.label(root, "")
  detail:align("center", 0, 18)

  local hint = badge.ui.label(root, "A SCAN   B MODE   HOME EXIT")
  hint:align("bottom_mid", 0, -16)

  enabled = badge.nfc.enable()
  if enabled then
    badge.nfc.clear()
    show_waiting()
  else
    show_result(false, "NFC UNAVAILABLE")
  end
end

function on_tick()
  if not enabled or screen ~= "waiting" then return end

  local now = badge.sys.ms()
  if now < next_poll then return end
  next_poll = now + 200

  local card = badge.nfc.card()
  if card and card.uid and card.uid ~= last_uid then
    last_uid = card.uid
    if type(card.uid) == "string" and card.uid ~= "" then
      show_result(true, card.uid)
    else
      show_result(false, "INVALID BADGE ID")
    end
  end
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED then return end
  if button == badge.input.BUTTON.B and enabled and screen == "waiting" then
    mode = mode == "receive" and "send" or "receive"
    badge.nfc.clear()
    last_uid = nil
    show_waiting()
  elseif button == badge.input.BUTTON.A and enabled then
    badge.nfc.clear()
    last_uid = nil
    show_waiting()
  end
end

function on_exit()
  if enabled then
    badge.nfc.disable()
  end
  badge.led.clear()
  badge.led.show()
end
