# SolarPay

## Inspiration
After playing around with the hacker badges for a while, we kept looking at Solana and found it unique that Solana sponsored this hardware project. The tap kept making us think of how Apple Pay works, and it turns out we can quite literally make this a payments hardware device as well!

## What it does
Tap two badges together, one pays the other in SOL. 

## How we built it
Native C firmware flashed onto the badge hardware, over radio, with a settlement backend watching Solana Devnet and a web dashboard tying wallets to badges.

## Challenges we ran into
Badge memory is tiny, so every byte and radio packet had to be optimized for. Also figuring out the UX for who's the "merchant" and who's the "customer" when every device is the same.

## Accomplishments that we're proud of
After flashing the hardware we got to implement our fully custom UI and were able to leverage knocking/tapping for a custom app.

## What we learned
Sometimes the fastest path is wiping the slate and starting over. We ended up flashing the firmware, and got to implement an even nicer UI +UX on the badge.

## What's next for SolarPay
Receipts, more detailed merchant dashboards, one-tap onboarding, and stablecoin support!
