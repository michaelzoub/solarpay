--[==[badge-app
slug=solarpay_sender
name=SolarPay Sender
icon=GIVE
api=2
heap_kb=96
wake_lock=1
version=2.0.0
]==]
-- Paying is now two deliberate acts, not one. Knocking the badges together
-- establishes an SPL1 link with exactly one merchant (badges/lib/splink.lua);
-- the payment is only sent after the payer presses A on a screen naming that
-- merchant and the amount. A tap on its own never moves money.
--#include lib/splink.lua
local profile_id="__SOLARPAY_BADGE_ID__"
local wallet="__SOLARPAY_WALLET_ADDRESS__"
local balance="__SOLARPAY_BALANCE__"
local has_qr="__SOLARPAY_QR_AVAILABLE__"=="1"
local radio_ok,seq=false,0
local my_id,my_mac,wallet_label
local intent,nonce,amount,item,expires=nil,nil,nil,"PAYMENT",0
local merchant_mac,merchant_rssi,merchant_seen,merchant_zone=nil,nil,0,nil
local link,link_state,link_note,confirming=nil,nil,nil,false
local last_dropped,next_proximity_log=0,0
local next_led=0
local item_id,item_name,paid_until,paid_started,laptop_until=nil,nil,0,0,0

local view,qr="balance",nil
local mode,state,kicker,value,detail,card,card_text,footer
local C={ink=0x10091F,panel=0x21143D,purple=0x9A5CFF,pink=0xFF4FD8,
cyan=0x4DEBFF,green=0x55F991,yellow=0xFFE45E,white=0xFFF8FF,
soft=0xC5AFDD,dim=0x806B9A}
local function id()
if my_id then return my_id end
if string.sub(profile_id,1,2)~="__" then return profile_id end
return badge.me.badge_id() or "UNLINKED"
end
local function emit(kind,fields)
seq=seq+1
badge.sys.log("SP_EVT|v=3|seq="..seq.."|role=customer|type="..kind..(fields and "|"..fields or ""))
end
local function leds(r,g,b)
badge.led.clear(); badge.led.set_all(r,g,b); badge.led.show()
end
local function money(n)
return string.format("%.4f SOL",(n or 0)/1000000000)
end
local function wallet_short()
if #wallet < 18 or string.sub(wallet,1,2)=="__" then return "WALLET NOT LINKED" end
return string.sub(wallet,1,6).."..."..string.sub(wallet,-6)
end
local function layout()
kicker:align("top_left",12,66); value:align("top_left",12,84); detail:align("top_left",12,113)
card:set_size(296,82); card:align("bottom_mid",0,-26)
card_text:hidden(false); card_text:set_color(C.white); card_text:align("center",0,0)
if qr then qr:hidden(true) end
end
-- Advisory only; see the matching note in solarpay_merchant.lua. splink decides
-- who the counterparty is, using simultaneity and uniqueness as well as signal
-- strength, because RSSI alone could not tell "touching" from "nearby".
local function rssi_zone(rssi)
if rssi >= splink.DEFAULTS.RSSI_GATE then return "touching" end
if rssi >= -82 then return "near" end
return "far"
end
local function merchant_near(now)
return merchant_mac and now-merchant_seen < 2600 and merchant_zone~="far"
end
local function refresh_link_peer(now)
if not link then return end
local p=link:paired_peer() or link:best_peer()
if not p then
  if merchant_mac and now-merchant_seen>=2600 then merchant_mac,merchant_rssi,merchant_zone=nil,nil,nil end
  return
end
merchant_mac,merchant_rssi,merchant_seen=p.mac,p.rssi,now
merchant_zone=rssi_zone(p.rssi)
end
local function render_leds(now)
badge.led.clear()
if now < paid_until then
local elapsed=now-paid_started
if elapsed<1080 then local phase=math.floor(elapsed/180); if phase==0 or phase==2 or phase==4 then badge.led.set_all(0,255,90) end
else badge.led.set_all(0,80,35) end
elseif merchant_zone=="touching" and merchant_near(now) then
badge.led.set_all(0,255,90)
elseif merchant_near(now) then
local level=110+math.floor((now % 900)/900 * 145)
badge.led.set(1,0,level,level); badge.led.set(6,0,level,level); badge.led.set(5,0,level,level)
elseif intent then
local level=55+math.floor((now % 1400)/1400 * 75); badge.led.set_all(level,level,0)
else badge.led.set_all(18,8,35) end
badge.led.show()
end
local function paint(now)
layout()
if now < paid_until then
state:set_text("PAID"); state:set_color(C.green); mode:set_text("[ PAYMENT SENT ]"); mode:set_color(C.green)
kicker:set_text("PAID  ·  "..money(amount)); kicker:set_color(C.green)
value:set_text(item); detail:set_text("WAITING FOR CONFIRMATION")
card:set_color(0x143D30); card:set_border(C.green,2)
card_text:set_text("+ APPROVAL SENT +\nSENT TO TERMINAL\nVERIFYING ON SOLANA")
footer:set_text("HOME EXIT"); render_leds(now); return
end
if intent then
state:set_text("REQUEST"); state:set_color(C.yellow); mode:set_text("[ PAYMENT REQUEST ]"); mode:set_color(C.cyan)
kicker:set_text("PAY  ·  "..money(amount)); kicker:set_color(C.pink); kicker:align("top_mid",0,66)
value:set_text(item); value:align("top_mid",0,89); detail:align("top_mid",0,116)
card:set_color(C.panel); card:set_size(220,42); card:align("bottom_mid",0,-32)
if confirming and link_state==splink.PAIRED then
local peer=link:paired_peer()
state:set_text("CONFIRM"); state:set_color(C.green)
detail:set_text(link_note or "PRESS A TO PAY THIS MERCHANT")
card:set_border(C.green,3)
card_text:set_text("PAY "..money(amount).."\nTO "..(peer and peer.sid or "MERCHANT").."\nA CONFIRM    B CANCEL")
footer:set_text("A CONFIRM   B CANCEL   HOME EXIT"); render_leds(now); return
elseif merchant_near(now) then
local touching=merchant_zone=="touching"
detail:set_text(link_note or (touching and "BADGES ALIGNED - KNOCK NOW" or "< BRING TO MERCHANT LEFT EDGE"))
card:set_border(touching and C.green or C.cyan,3); card_text:set_text(touching and "KNOCK TO PAIR" or "<<<  LEFT EDGE")
else
detail:set_text(link_note or "CHECK ITEM AND AMOUNT"); card:set_border(C.yellow,2); card_text:set_text("KNOCK ON MERCHANT\nTHEN A TO PAY")
end
footer:set_text("B DECLINE   HOME EXIT"); render_leds(now); return
end
local online=now < laptop_until
state:set_text(online and "ONLINE" or "OFFLINE"); state:set_color(online and C.cyan or C.purple)
mode:set_text(online and "[ CONNECTED ]" or "[ SENDER ]"); mode:set_color(online and C.cyan or C.dim)
if view=="balance" then
kicker:set_text("READY TO PAY"); kicker:set_color(C.yellow); value:set_text(balance.." SOL"); detail:set_text("AVAILABLE BALANCE")
card:set_color(C.panel); card:set_border(merchant_near(now) and C.cyan or C.purple,merchant_near(now) and 3 or 2)
card_text:set_text("HOW TO PAY\nHOLD NEAR CHECKOUT\nREVIEW, THEN PRESS A"); footer:set_text("B SHOW PAY CODE   HOME EXIT")
else
kicker:set_text("SEND COINS"); kicker:set_color(C.cyan); value:set_text(has_qr and "SCAN ME" or "PAYMENT ID")
detail:set_text(has_qr and "SOLARPAY CODE" or id()); card:set_color(0xF7F2FF); card:set_border(C.pink,2)
card_text:set_text("< PLAYER PAY CODE >\n"..my_id.."\n"..wallet_label); card_text:set_color(C.ink); footer:set_text("B BALANCE   HOME EXIT")
if has_qr then
if not qr then qr=badge.ui.image(card,"qr.bin"); qr:align("center",0,0) end
card_text:hidden(true); qr:hidden(false); qr:bring_to_front()
end
end
render_leds(now)
end
local function clear(kind)
local old=intent
intent,nonce,amount,item,expires=nil,nil,nil,"PAYMENT",0
confirming=false; link_state,link_note=nil,nil
if link and link:armed() then link:disarm(splink.CANCELLED) end
if kind then emit(kind,"intent="..tostring(old)) end
paint(badge.sys.ms())
end
-- Called only from the A button, and only while paired. There is deliberately
-- no path from "badges touched" straight to "paid".
local function approve(method)
if not intent then return end
local now=badge.sys.ms()
if not link or link.state~=splink.PAIRED then
emit("approval_rejected","reason=not_paired|intent="..intent.."|state="..tostring(link and link.state))
link_note="KNOCK THE BADGES TOGETHER FIRST"; leds(255,35,65); paint(now); return
end
if link:sending() then emit("approval_rejected","reason=already_sending"); return end
local message="A:"..intent..":"..string.sub(my_id,1,16)..":"..nonce
local ok,why=link:send_message(message)
if not ok then emit("approval_send_failed","intent="..intent.."|reason="..tostring(why)); return end
local peer=link:paired_peer()
paid_until,paid_started=now+3000,now
link_note="SENDING APPROVAL..."
emit("touch","method="..method.."|intent="..intent.."|peer_mac="..tostring(peer and peer.mac).."|rssi="..tostring(peer and peer.rssi))
emit("approval_queued","intent="..intent.."|bytes="..#message); paint(now)
end
function on_enter(root)
if string.sub(balance,1,2)=="__" then balance="--" end
my_id=id(); wallet_label=wallet_short()
local shell=badge.ui.box(root,320,240); shell:style({bg_color=C.ink,radius=0,border_width=0})
local brand=badge.ui.label(shell,"solarpay"); brand:style({text_color=C.white,text_font=22}); brand:align("top_mid",0,7)
mode=badge.ui.label(shell,"[ STARTING ]"); mode:style({text_color=C.dim,text_font=14}); mode:align("top_left",12,37)
state=badge.ui.label(shell,"BOOT"); state:style({text_color=C.purple,text_font=14}); state:align("top_right",-12,37)
kicker=badge.ui.label(shell,"INSERT COIN"); kicker:style({text_color=C.yellow,text_font=14})
value=badge.ui.label(shell,"LOADING..."); value:style({text_color=C.white,text_font=24})
detail=badge.ui.label(shell,"POWERING PAYMENT LINK"); detail:style({text_color=C.soft,text_font=14})
card=badge.ui.box(shell,296,82); card:style({bg_color=C.panel,radius=0,border_color=C.purple,border_width=2})
card_text=badge.ui.label(card,"$ SOLARPAY $"); card_text:style({text_color=C.white,text_font=14,text_align="center"})
footer=badge.ui.label(shell,"HOME EXIT"); footer:style({text_color=C.dim,text_font=14}); footer:align("bottom_mid",0,-5)
local solana_logo=badge.ui.image(shell,"solana.bin"); solana_logo:align("bottom_right",-6,-6)
badge.sys.log("SOLARPAY_BADGE:customer:"..my_id); emit("app_enter","badge_id="..my_id)
radio_ok=badge.radio.enable()
if radio_ok then
my_mac=badge.radio.mac()
emit("radio_ready","mac="..my_mac)
link=splink.new({
ms=function() return badge.sys.ms() end,
send=function(p) return badge.radio.send(p) end,
random=function(n) return badge.sys.random(n) end,
log=function(l) badge.sys.log(l) end,
},{role="S"})
link:on("state",function(st) link_state=st; paint(badge.sys.ms()) end)
link:on("impact",function(mag) emit("impact","mag="..mag) end)
link:on("ambiguous",function(count)
link_note="TOO MANY BADGES - TRY AGAIN"
emit("approval_rejected","reason=ambiguous_tap|count="..count); paint(badge.sys.ms())
end)
link:on("paired",function(p)
confirming=true; link_note=nil
merchant_mac,merchant_rssi,merchant_seen=p.mac,p.rssi,badge.sys.ms()
merchant_zone=rssi_zone(p.rssi)
emit("peer_detected","peer_sid="..p.sid.."|peer_mac="..p.mac.."|rssi="..p.rssi.."|lid="..link.lid)
paint(badge.sys.ms())
end)
link:on("sent",function()
link_note="APPROVAL DELIVERED"; emit("approval_delivered","intent="..tostring(intent)); paint(badge.sys.ms())
end)
link:on("send_failed",function(code)
paid_until=0; link_note="MERCHANT DID NOT ANSWER - PRESS A AGAIN"
emit("approval_send_failed","intent="..tostring(intent).."|code="..code); paint(badge.sys.ms())
end)
link:on("closed",function() confirming=false; link_note="MERCHANT LEFT"; paint(badge.sys.ms()) end)
link:on("expired",function() confirming=false; link_note="PAIRING WINDOW CLOSED"; paint(badge.sys.ms()) end)
badge.radio.on_recv(function(mac,rssi,payload)
if mac==my_mac or type(payload)~="string" then return end
if string.sub(payload,1,4)==splink.VERSION then link:on_frame(mac,rssi,payload); return end
if string.sub(payload,1,6)=="SP1:M:" then
local a,b=string.match(payload,"^SP1:M:([0-9a-f]+):([A-Za-z0-9_-]+)$")
if a then item_id,item_name=a,string.gsub(b,"_"," "); if intent==a then item=item_name; paint(badge.sys.ms()) end end
return
end
local a,b,c,d=string.match(payload,"^SP1:I:([0-9a-f]+):(%d+):(%d+):([A-Za-z0-9_-]+):[A-Za-z0-9_-]+$")
if not a then if string.sub(payload,1,6)=="SP1:I:" then emit("intent_rejected","reason=invalid_format") end; return end
local fresh=intent~=a
intent,amount,nonce,expires=a,tonumber(b),d,badge.sys.ms()+math.min(tonumber(c),90)*1000
item=item_id==a and item_name or "PAYMENT"; merchant_mac,merchant_rssi,merchant_seen=mac,rssi,badge.sys.ms(); merchant_zone=rssi_zone(rssi)
-- A payment request is the only thing that opens a pairing window. The radio
-- is not armed for pairing at any other time.
if fresh and not link:armed() then
local sid=link:arm(); confirming=false; link_note="KNOCK ON THE MERCHANT BADGE"
emit("link_armed","intent="..a.."|sid="..sid)
end
emit("intent_received","intent="..a.."|lamports="..b.."|ttl="..c); paint(badge.sys.ms())
end)
else emit("radio_unavailable") end
paint(badge.sys.ms())
end
function on_tick()
local now=badge.sys.ms()
if link then
local x,y,z=badge.sensor.accel()
link:feed_accel(x,y,z,badge.sensor.tap())
link:tick()
local before=merchant_zone
refresh_link_peer(now)
if merchant_zone~=before then
if merchant_zone then emit("proximity","peer="..tostring(merchant_mac).."|rssi="..tostring(merchant_rssi).."|zone="..merchant_zone)
else emit("proximity_lost","peer="..tostring(merchant_mac)) end
paint(now)
elseif merchant_zone and now>=next_proximity_log then
next_proximity_log=now+1500
emit("proximity","peer="..tostring(merchant_mac).."|rssi="..tostring(merchant_rssi).."|zone="..merchant_zone)
end
end
if paid_until>0 and now>=paid_until and link and not link:sending() then paid_until=0; clear(nil) end
if laptop_until>0 and now>=laptop_until then laptop_until=0; emit("laptop_disconnected"); paint(now) end
if radio_ok then
local dropped=badge.radio.dropped()
if dropped~=last_dropped then last_dropped=dropped; emit("radio_dropped","count="..dropped) end
end
if intent and now>=expires then clear("intent_expired") end
if now>=next_led then next_led=now+75; render_leds(now) end
end
function on_button(button,kind)
local pressed=kind==badge.input.KIND.PRESSED
local now=badge.sys.ms()
if button==badge.input.BUTTON.AUX1 then
if pressed then local was=now<laptop_until; laptop_until=now+45000; if not was then emit("laptop_connected"); paint(now) end end
return
end
emit("button","button="..tostring(button).."|kind="..(pressed and "pressed" or "released")); if not pressed then return end
if button==badge.input.BUTTON.A and intent then approve("button_a_confirm")
elseif button==badge.input.BUTTON.B and intent then clear("intent_declined")
elseif button==badge.input.BUTTON.B then view=view=="balance" and "send" or "balance"; emit("view_changed","view="..view); paint(now) end
end
function on_exit()
emit("app_exit"); if radio_ok then badge.radio.on_recv(nil); badge.radio.disable() end; badge.led.clear(); badge.led.show()
end
