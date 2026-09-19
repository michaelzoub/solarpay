--[==[badge-app
slug=solarpay_sender
name=SolarPay Sender
icon=GIVE
api=2
heap_kb=96
wake_lock=1
version=1.6.0
]==]
local profile_id="__SOLARPAY_BADGE_ID__"
local wallet="__SOLARPAY_WALLET_ADDRESS__"
local balance="__SOLARPAY_BALANCE__"
local has_qr="__SOLARPAY_QR_AVAILABLE__"=="1"
local radio_ok,seq,next_beacon=false,0,0
local my_id,my_mac,beacon,wallet_label
local intent,nonce,amount,item,expires=nil,nil,nil,"PAYMENT",0
local merchant_mac,merchant_rssi,merchant_seen,merchant_zone=nil,nil,0,nil
local last_dropped,next_proximity_log=0,0
local next_led=0
local item_id,item_name,paid_until,paid_started,laptop_until=nil,nil,0,0,0
local apkt,auntil,anext,next_tap=nil,0,0,0
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
local function rssi_zone(rssi)
-- Widened from -55/-68: enclosure + lanyard attenuation on real badges reads
-- well below open-air BLE RSSI even edge-to-edge, so the tighter thresholds
-- never fired "near"/"touching" and bump approval silently rejected every time.
if rssi >= -62 then return "touching" end
if rssi >= -82 then return "near" end
return "far"
end
local function merchant_near(now)
return merchant_mac and now-merchant_seen < 2600 and merchant_zone~="far"
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
if merchant_near(now) then
local touching=merchant_zone=="touching"
detail:set_text(touching and "BADGES ALIGNED - BUMP NOW" or "< TAP LEFT EDGE ON MERCHANT")
card:set_border(touching and C.green or C.cyan,3); card_text:set_text(touching and "BUMP OR A TO PAY" or "<<<  LEFT EDGE")
else
detail:set_text("CHECK ITEM AND AMOUNT"); card:set_border(C.yellow,2); card_text:set_text("A PAY    B DECLINE")
end
footer:set_text("A PAY   B DECLINE   HOME EXIT"); render_leds(now); return
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
apkt,auntil,anext=nil,0,0
if kind then emit(kind,"intent="..tostring(old)) end
paint(badge.sys.ms())
end
local function approve(method)
if not intent then return end
local now=badge.sys.ms()
if not merchant_near(now) then
emit("approval_rejected","reason=merchant_not_near|intent="..intent.."|zone="..tostring(merchant_zone).."|rssi="..tostring(merchant_rssi).."|age_ms="..tostring(merchant_mac and now-merchant_seen or -1))
detail:set_text("MOVE CLOSER AND TAP AGAIN"); leds(255,35,65); return
end
local packet="SP1:A:"..intent..":"..string.sub(my_id,1,16)..":"..nonce
if #packet > 44 then emit("approval_rejected","reason=packet_too_long"); return end
if badge.radio.send(packet) then
apkt,auntil,anext=packet,now+1800,now+250
paid_until,paid_started=now+3000,now; emit("touch","method="..method.."|intent="..intent.."|peer_mac="..merchant_mac.."|rssi="..tostring(merchant_rssi))
emit("approval_queued","intent="..intent.."|bytes="..#packet); paint(now)
else emit("approval_send_failed","intent="..intent) end
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
my_mac=badge.radio.mac(); beacon="SP2:P:C:"..string.sub(my_id,1,16)
emit("radio_ready","mac="..my_mac)
badge.radio.on_recv(function(mac,rssi,payload)
if mac==my_mac or type(payload)~="string" then return end
if string.sub(payload,1,8)=="SP2:P:M:" then
local now=badge.sys.ms()
if merchant_mac~=mac or not merchant_rssi then merchant_rssi=rssi else merchant_rssi=math.floor((merchant_rssi*3+rssi)/4) end
local zone=rssi_zone(merchant_rssi); merchant_mac,merchant_seen=mac,now
local changed=zone~=merchant_zone
if changed or now>=next_proximity_log then
next_proximity_log=now+1500; merchant_zone=zone
emit("proximity","peer="..mac.."|rssi="..merchant_rssi.."|zone="..zone)
if changed then paint(now) end
end
return
end
if string.sub(payload,1,6)=="SP1:M:" then
local a,b=string.match(payload,"^SP1:M:([0-9a-f]+):([A-Za-z0-9_-]+)$")
if a then item_id,item_name=a,string.gsub(b,"_"," "); if intent==a then item=item_name; paint(badge.sys.ms()) end end
return
end
local a,b,c,d=string.match(payload,"^SP1:I:([0-9a-f]+):(%d+):(%d+):([A-Za-z0-9_-]+):[A-Za-z0-9_-]+$")
if not a then if string.sub(payload,1,6)=="SP1:I:" then emit("intent_rejected","reason=invalid_format") end; return end
intent,amount,nonce,expires=a,tonumber(b),d,badge.sys.ms()+math.min(tonumber(c),90)*1000
item=item_id==a and item_name or "PAYMENT"; merchant_mac,merchant_rssi,merchant_seen=mac,rssi,badge.sys.ms(); merchant_zone=rssi_zone(rssi)
emit("intent_received","intent="..a.."|lamports="..b.."|ttl="..c); paint(badge.sys.ms())
end)
else emit("radio_unavailable") end
paint(badge.sys.ms())
end
function on_tick()
local now=badge.sys.ms()
if apkt and now<auntil and now>=anext then anext=now+250; badge.radio.send(apkt)
elseif apkt and now>=auntil then apkt=nil end
if paid_until>0 and now>=paid_until then paid_until=0; clear(nil) end
if laptop_until>0 and now>=laptop_until then laptop_until=0; emit("laptop_disconnected"); paint(now) end
if radio_ok then
local dropped=badge.radio.dropped()
if dropped~=last_dropped then last_dropped=dropped; emit("radio_dropped","count="..dropped) end
end
if radio_ok and now>=next_beacon then next_beacon=now+750; badge.radio.send(beacon) end
if intent and now>=expires then clear("intent_expired") end
if merchant_mac and now-merchant_seen>=2600 then emit("proximity_lost","peer="..tostring(merchant_mac)); merchant_mac,merchant_rssi,merchant_seen,merchant_zone=nil,nil,0,nil; paint(now) end
if now>=next_tap then
local tapped=badge.sensor.tap(); local shaken=badge.sensor.shake()
if tapped or shaken then next_tap=now+600; if intent then approve(tapped and "radio_tap" or "radio_shake") else emit("touch_unpaired","reason=no_payment_request") end end
end
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
if button==badge.input.BUTTON.A and intent then approve("button_a")
elseif button==badge.input.BUTTON.B and intent then clear("intent_declined")
elseif button==badge.input.BUTTON.B then view=view=="balance" and "send" or "balance"; emit("view_changed","view="..view); paint(now) end
end
function on_exit()
emit("app_exit"); if radio_ok then badge.radio.on_recv(nil); badge.radio.disable() end; badge.led.clear(); badge.led.show()
end
