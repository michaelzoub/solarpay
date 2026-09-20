# Settlement reaches both badges

Date: 2026-09-19
Status: approved, not yet implemented

## Problem

Two defects, found while gating merchant mode on a connected badge.

**The sender badge never learns what happened to its money.** `s_balance_lamports`
(`firmware/solarpay/main/main.c:73`) changes only through `wallet_store()`, which runs
only on an `SP_WALLET` line arriving over USB. After a payment the sender badge still
shows its pre-payment balance. Its terminal screen is `sender/paid` -- "confirming on
Solana" -- held for three seconds and then cleared, whether or not the transaction
confirmed. `on_confirm_line()` (`main.c:769`) returns early unless the badge is in
merchant mode, so the signature never reaches the sender even over a cable.

**There is no channel open when the signature exists.** On receiving the approval the
merchant calls `splink_disarm(SPLINK_CLOSE_OK)` (`main.c:676`), closing the radio link
before the laptop begins settling on Solana. By the time a signature exists, the two
badges are no longer talking.

**Merchant mode does not require a badge.** The checkout sheet opens with no badge
connected; the user discovers the problem only at the disabled submit button. The
sender journey already gates on `badgeReady` and says so in its hero.

## Decisions

Both were chosen over the alternatives listed under Rejected alternatives.

1. **Hold the splink pair open through settlement** rather than cabling the sender
   badge or deducting optimistically. The sender stays on battery, which is the whole
   demo.
2. **Never show an unbacked number.** No deduction until a confirmation actually
   arrives. On failure or timeout the badge keeps the old balance and says it could not
   confirm.

## Design

### 1. Merchant firmware: hold the link through settlement

In `cb_message()`, remove the `splink_disarm(SPLINK_CLOSE_OK)` on approval. Set
`s_awaiting_confirm` with a deadline of `now_ms() + SP_SETTLE_TIMEOUT_MS` (10000).
Clearing `s_intent_packet` and `s_item_packet` still stops the broadcast exactly as
today, so the beacon goes quiet and no new payer can pair; only the existing pair
survives.

`on_confirm_line()` relays over that surviving link:

    C:<intent>:<signature>:<payer_lamports>

then disarms on `cb_delivered`, `cb_send_failed`, or the deadline, whichever comes
first. `on_fail_line()` relays `X:<intent>` the same way, so a failed settlement is
never silence on the sender.

The merchant badge does not know the sender's balance, only its own. `SP_CONFIRM`
therefore grows an optional third field carrying the payer's post-settlement lamports,
which the laptop looks up and passes down. This follows the convention already
established at `main.c:770`, where the signature is optional so an older caller still
works. The laptop remains the source of truth, and the deduction reflects the real
on-chain balance including network fees rather than a local guess at `s_lamports`.

Console grammar, both forms accepted:

    SP_CONFIRM <intent>
    SP_CONFIRM <intent> <signature>
    SP_CONFIRM <intent> <signature> <payer_lamports>

### 2. Sender firmware: receive, deduct, display

`cb_message()` gains `C:` and `X:` branches, each guarded on the intent matching
`s_intent` so a stale or foreign packet cannot move the balance.

On `C:`, the sender calls the existing `wallet_store(s_wallet, lamports)` so the new
balance persists to NVS and survives the battery, copies the signature into
`s_signature`, and sets the result to CONFIRMED.

The paid screen becomes three states instead of a flat three-second timer
(`main.c:832`):

| State | Shows | Duration |
|---|---|---|
| awaiting | `Sent` · "confirming on Solana" (today's text) | ~12 s, one beat past the merchant deadline |
| confirmed | `Paid`, the new balance, the shortened hash | 5 s, matching the merchant result screen |
| failed or timed out | "Not confirmed -- reconnect to refresh", balance untouched | 5 s |

The hash is shortened with the `%.6s...%.6s` formatting the merchant already uses at
`main.c:464`, so one signature reads identically on both badges.

`on_confirm_line()`'s `s_mode != MODE_MERCHANT` early return stays. The sender's path
is the radio one, not USB.

### 3. Web app: refresh both badges

In `settleBadgeApproval()` (`web/App.jsx`), after the submit succeeds, read the payer's
balance using `fields.customer_badge_id` and pass it into the confirm line:

    SP1:C:<id> <signature> <payerLamports>

Today only the merchant is re-synced. The sender must be refreshed too -- but **not**
through `syncBadge()`, which owns `syncedBadge`, `balance` and `qrCode` for the badge
connected to this laptop. Calling it for the sender would replace the header panel with
the sender's wallet. The sender gets a plain balance read plus a `loadBadges()` refresh
of the list.

The merchant focus panel already renders `intent.signature` and the explorer link at
step 5; no change needed there.

### 4. Merchant mode requires a connected badge

In the `journey === "merchant" && !requestActive` branch, split on `badgeReady`
(`syncedBadge && setupStage >= 3`) -- the same flag the sender hero already uses, and
the one that guarantees `terminalBadgeId` exists for `createPayment()`.

- **Not ready:** the lede reads "Connect your merchant badge to start taking payments,"
  and the `.invite` card is replaced by a connect card carrying the badge glyph,
  "Connect your badge" and "Required to take payments". Clicking it opens the badge
  popover in the header. The checkout sheet is unreachable.
- **Ready:** exactly today's behaviour.

`Popover` gains one optional prop: a ref it writes `{ open() }` into, so `App` can open
the badge popover from the stage. The header trigger is otherwise untouched.

The sheet's existing `!canRequest` disabled state stays as a safety net. If USB drops
while the sheet is open, `clearConnectedUser()` wipes `syncedBadge` mid-flight and the
gate behind the dialog will not have re-rendered.

Recent payments stays ungated -- reading history needs no badge.

Styling reuses the `.invite` card shape with an `.invite-connect` modifier in
`web/styles.css`, so it reads as the same object in a different state rather than a new
component.

## Testing

Corrected during implementation. `test/splink.test.lua` exercises the Lua link layer in
`badges/lib/splink.lua`; the relay lives in the C firmware and is not reachable from it.
The split is therefore:

- `test/badge-serial.test.js` (host, automated): the confirm line carries the signature
  and the payer's balance; a confirm with only a signature, and one with only an intent,
  both still settle. This covers the wire format the firmware parses.
- `tools/e2e/scenarios.js` (needs the two-badge rig): settlement reaches the sender --
  balance deducted to the relayed figure, hash matching the merchant's, and the merchant
  releasing the link afterwards; and a failed settlement leaving the balance untouched.
- The C parse of `SP_CONFIRM`'s third field has no host-level test. It is covered only by
  the e2e rig, because the firmware does not build for the host.

## Risks

Holding the pair open leaves the merchant linked-but-unpairable for up to 10 s. A
second payer knocking during settlement gets nothing. This is also true today, since
the broadcast has already stopped by then, so it is not a regression.

If the sender badge is power-cycled between approval and confirmation, the relay is
lost and the balance stays stale until the badge is next provisioned over USB. The
failure text tells the user exactly that.

The payer balance is read immediately after submit returns. If the RPC node has not yet
reflected the transfer, the figure relayed to the badge could be one block stale. The
read therefore happens against the same commitment the submit call confirmed at; if
that proves flaky in practice, the fallback is to relay `balance - lamports - fee` and
let the next USB provision correct it.

## Rejected alternatives

**Cable the sender badge.** The web app opens a second WebSerial port and pushes
`SP_WALLET` after settlement. Almost no firmware work, since `wallet_store` already
exists -- but the sender must be tethered, which breaks the battery/tap demo, and
Chrome currently holds only the merchant port.

**Optimistic local deduction.** The sender subtracts `s_lamports` when it sends its
approval. Cheapest and needs no new transport, but it shows a drop even when settlement
later fails, ignores the network fee, and the badge can never show the hash.

**Gate merchant mode at the click or at the sheet note.** Leaves the user able to fill
in a form that goes nowhere.
