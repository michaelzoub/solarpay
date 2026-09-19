--[==[badge-app
slug=solarpay_merchant
name=SolarPay Merchant
icon=SHOP
api=2
heap_kb=96
wake_lock=1
version=1.6.0
]==]
local profile_id="__SOLARPAY_BADGE_ID__"
local wallet="__SOLARPAY_WALLET_ADDRESS__"
local radio_ok,seq,next_beacon,next_send=false,0,0,0
local my_id,my_mac,beacon,wallet_label
local intent,nonce,packet,item_packet,amount,item,expires=nil,nil,nil,nil,nil,"PAYMENT",0
local payer_id,payer_mac,payer_rssi,payer_seen,payer_zone=nil,nil,nil,0,nil
local last_dropped,next_proximity_log=0,0
local next_led=0
local approved=nil
local result,result_until,result_started,laptop_until="",0,0,0
local mode,state,kicker,value,detail,card,card_text,footer
local C={ink=0x10091F,panel=0x21143D,purple=0x9A5CFF,pink=0xFF4FD8,cyan=0x4DEBFF,
green=0x55F991,yellow=0xFFE45E,red=0xFF304F,white=0xFFF8FF,soft=0xC5AFDD,dim=0x806B9A}
local function id()
if my_id then return my_id end
if string.sub(profile_id,1,2)~="__" then return profile_id end
return badge.me.badge_id() or "UNLINKED"
end
local function emit(kind,fields)
seq=seq+1; badge.sys.log("SP_EVT|v=3|seq="..seq.."|role=merchant|type="..kind..(fields and "|"..fields or ""))
end
local function leds(r,g,b) badge.led.clear(); badge.led.set_all(r,g,b); badge.led.show() end
local function money(n) return string.format("%.4f SOL",(n or 0)/1000000000) end
local function wallet_short()
if #wallet<18 or string.sub(wallet,1,2)=="__" then return "WALLET NOT LINKED" end
return string.sub(wallet,1,6).."..."..string.sub(wallet,-6)
end
local function layout()
kicker:align("top_left",12,66); value:align("top_left",12,84); detail:align("top_left",12,113)
card:set_size(296,82); card:align("bottom_mid",0,-26); card_text:hidden(false); card_text:align("center",0,0)
end
local function rssi_zone(rssi)
-- Widened from -55/-68: enclosure + lanyard attenuation on real badges reads
-- well below open-air BLE RSSI even edge-to-edge, so the tighter thresholds
-- never fired "near"/"touching" and bump approval silently rejected every time.
if rssi>=-62 then return "touching" end
if rssi>=-82 then return "near" end
return "far"
end
local function peer_near(now) return payer_mac and now-payer_seen<2600 and payer_zone~="far" end
local function render_leds(now)
badge.led.clear()
if now<result_until then
if result=="FAILED" then badge.led.set_all(255,25,45)
elseif result=="APPROVED" or result=="CONFIRMED" then
local elapsed=now-result_started
if elapsed<1080 then local phase=math.floor(elapsed/180); if phase==0 or phase==2 or phase==4 then badge.led.set_all(0,255,90) end
elseif result=="CONFIRMED" then badge.led.set_all(0,255,90) else badge.led.set_all(0,80,35) end
else badge.led.set_all(220,150,0) end
elseif payer_zone=="touching" and peer_near(now) then
badge.led.set_all(0,255,90)
elseif peer_near(now) then
local level=110+math.floor((now%900)/900*145)
badge.led.set(2,0,level,level); badge.led.set(3,0,level,level); badge.led.set(4,0,level,level)
elseif intent then
local level=90+math.floor((now%1400)/1400*165); badge.led.set_all(0,level,45)
else badge.led.set_all(0,20,10) end
badge.led.show()
end
local function paint(now)
layout()
if now<result_until then
local failed=result=="FAILED"; local color=failed and C.red or (result=="CONFIRMED" and C.green or C.yellow)
state:set_text(failed and "ERROR" or (result=="CONFIRMED" and "PAID" or "TAP")); state:set_color(color)
mode:set_text("[ PAYMENT LINK ]"); mode:set_color(color); kicker:set_text(failed and "PAYMENT STOPPED" or (result=="CONFIRMED" and "SOLANA SETTLED" or "PAYER APPROVED")); kicker:set_color(color)
value:set_text(failed and "FAILED" or (result=="CONFIRMED" and "CONFIRMED" or "SIGNING...")); detail:set_text(amount and money(amount) or "TOUCH EVENT RECEIVED")
card:set_color(failed and 0x3D1420 or 0x143D30); card:set_border(color,2)
card_text:set_text((result=="CONFIRMED" and "+ PAYMENT CONFIRMED +" or (failed and "! CHECK LAPTOP LOG !" or "+ APPROVAL RECEIVED +")).."\n"..(payer_id or "PAYER").."\n"..(failed and "TRANSACTION NOT SETTLED" or "VERIFYING ON SOLANA")); footer:set_text("HOME EXIT")
render_leds(now); return
end
if intent then
state:set_text("LIVE"); state:set_color(C.pink); mode:set_text("[ CHECKOUT READY ]"); mode:set_color(C.cyan)
kicker:set_text("PAYMENT  ·  "..money(amount)); kicker:set_color(C.yellow); kicker:align("top_mid",0,66)
value:set_text(item); value:align("top_mid",0,88); detail:align("top_mid",0,116)
card:set_color(C.panel); card:set_size(220,38); card:align("bottom_mid",0,-34)
if peer_near(now) then
local touching=payer_zone=="touching"
detail:set_text(touching and "BADGES ALIGNED - BUMP NOW" or "TAP SENDER ON RIGHT EDGE >")
card:set_border(touching and C.green or C.cyan,3); card_text:set_text(touching and "< BUMP TO PAY >" or "RIGHT EDGE  >>>")
else
detail:set_text("WAITING FOR SENDER BADGE"); card:set_border(C.green,2); card_text:set_text("TAP ON RIGHT EDGE  >>>")
end
footer:set_text("B CANCEL   HOME EXIT"); render_leds(now); return
end
local online=now<laptop_until
state:set_text(online and "ONLINE" or "OFFLINE"); state:set_color(online and C.cyan or C.purple)
mode:set_text(online and "[ USB RECEIVE MODE ]" or "[ MERCHANT ]"); mode:set_color(online and C.cyan or C.dim)
kicker:set_text("READY TO SELL"); kicker:set_color(C.yellow); value:set_text("WAITING..."); detail:set_text(online and "CREATE A PAYMENT ON LAPTOP" or "CONNECT USB TO CHARGE")
card:set_color(C.panel); card:set_border(peer_near(now) and C.cyan or C.purple,peer_near(now) and 3 or 2); card_text:set_text("$ SOLARPAY CHECKOUT $\n"..my_id.."\n"..wallet_label); footer:set_text("HOME EXIT"); render_leds(now)
end
local function clear(kind)
local old=intent; intent,nonce,packet,item_packet,amount,item,expires=nil,nil,nil,nil,nil,"PAYMENT",0
approved=nil
if kind then emit(kind,"intent="..tostring(old)) end; paint(badge.sys.ms())
end
local function load_intent()
local raw=badge.fs.read("intent.txt"); if not raw then emit("intent_load_failed","reason=missing_file"); return end
local confirmed=string.match(raw,"^SP1:C:([0-9a-f]+)")
if confirmed then local now=badge.sys.ms(); intent,packet,item_packet,approved=nil,nil,nil,nil; result,result_until,result_started="CONFIRMED",now+5000,now; emit("settlement_confirmed","intent="..confirmed); paint(now); return end
local failed=string.match(raw,"^SP1:E:([0-9a-f]+)")
if failed then local now=badge.sys.ms(); intent,packet,item_packet,approved=nil,nil,nil,nil; result,result_until,result_started="FAILED",now+5000,now; emit("settlement_failed","intent="..failed); paint(now); return end
local a,b,c,d,label=string.match(raw,"^SP1:I:([0-9a-f]+):(%d+):(%d+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)")
if not a then emit("intent_load_failed","reason=invalid_format"); return end
-- `label` above is the merchant's own 2-char tag from the SP1:I line, not the
-- item name. The item text is the second line of intent.txt (the SP1:M
-- packet); parse it separately instead of reusing `label` as the item.
local itemRaw=string.match(raw,"\nSP1:M:"..a..":([A-Za-z0-9_-]+)")
intent,amount,nonce=a,tonumber(b),d; item=itemRaw and string.gsub(itemRaw,"_"," ") or "PAYMENT"
approved=nil; expires=badge.sys.ms()+math.min(tonumber(c),90)*1000
packet="SP1:I:"..a..":"..b..":"..c..":"..d..":"..label
item_packet=itemRaw and ("SP1:M:"..a..":"..itemRaw) or nil; next_send=0
emit("intent_loaded","intent="..a.."|lamports="..b); emit("broadcast_requested","intent="..a); paint(badge.sys.ms())
end
function on_enter(root)
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
badge.sys.log("SOLARPAY_BADGE:merchant:"..my_id); emit("app_enter","badge_id="..my_id)
radio_ok=badge.radio.enable()
if radio_ok then
my_mac=badge.radio.mac(); beacon="SP2:P:M:"..string.sub(my_id,1,16)
emit("radio_ready","mac="..my_mac)
badge.radio.on_recv(function(mac,rssi,payload)
if mac==my_mac or type(payload)~="string" then return end
if string.sub(payload,1,8)=="SP2:P:C:" then
local now=badge.sys.ms()
if payer_mac~=mac or not payer_rssi then payer_rssi=rssi else payer_rssi=math.floor((payer_rssi*3+rssi)/4) end
local zone=rssi_zone(payer_rssi); payer_mac,payer_seen=mac,now
local changed=zone~=payer_zone
if changed or now>=next_proximity_log then
next_proximity_log=now+1500; payer_zone=zone
emit("proximity","peer="..mac.."|rssi="..payer_rssi.."|zone="..zone)
if changed then paint(now) end
end
return
end
if string.sub(payload,1,6)~="SP1:A:" then return end
local a,b,c=string.match(payload,"^SP1:A:([0-9a-f]+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$")
if not a or a~=intent or c~=nonce then emit("approval_ignored","reason=intent_mismatch"); return end
if approved==a then return end
approved=a
local now=badge.sys.ms(); payer_id,payer_mac,payer_rssi,payer_seen=b,mac,rssi,now; packet,item_packet=nil,nil; result,result_until,result_started="APPROVED",now+90000,now
badge.sys.log("SOLARPAY_APPROVAL:"..payload); emit("touch","method=radio_approval|intent="..a.."|peer_badge_id="..b.."|peer_mac="..mac.."|rssi="..rssi)
emit("approval_received","intent="..a.."|customer_badge_id="..b.."|nonce="..c.."|rssi="..rssi); paint(now)
end)
else emit("radio_unavailable") end
paint(badge.sys.ms())
end
function on_tick()
local now=badge.sys.ms()
if laptop_until>0 and now>=laptop_until then laptop_until=0; emit("laptop_disconnected"); paint(now) end
if radio_ok then
local dropped=badge.radio.dropped()
if dropped~=last_dropped then last_dropped=dropped; emit("radio_dropped","count="..dropped) end
end
if radio_ok and now>=next_beacon then next_beacon=now+750; badge.radio.send(beacon) end
if radio_ok and packet and now<expires and now>=next_send then next_send=now+450; badge.radio.send(packet); if item_packet then badge.radio.send(item_packet) end end
if intent and now>=expires then clear("intent_expired") end
if payer_mac and now-payer_seen>=2600 then emit("proximity_lost","peer="..tostring(payer_mac)); payer_mac,payer_rssi,payer_seen,payer_zone=nil,nil,0,nil; paint(now) end
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
if button==badge.input.BUTTON.START then load_intent()
elseif button==badge.input.BUTTON.B and intent then clear("intent_cancelled") end
end
function on_exit()
emit("app_exit"); if radio_ok then badge.radio.on_recv(nil); badge.radio.disable() end; badge.led.clear(); badge.led.show()
end
