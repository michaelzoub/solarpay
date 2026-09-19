// The laptop-facing serial contract, reimplemented natively.
//
// Only the MERCHANT badge needs this. The sender is standalone on battery: it
// learns the amount from the merchant's ESP-NOW broadcast and never needs USB.
//
// The lines this emits are byte-identical to what the Lua apps emitted, so
// server/ and web/badge-serial.js keep parsing exactly what they always parsed:
//
//   SOLARPAY_APPROVAL:SP1:A:<intent>:<badge_id>:<nonce>
//   SP_EVT|v=3|seq=<n>|role=<role>|type=<kind>|<fields>
//
// Inbound, the stock firmware took a file written over its console. There is no
// filesystem console here, so intents arrive as plain lines instead:
//
//   SP_INTENT SP1:I:<intent>:<lamports>:<ttl>:<nonce>:<tag>
//   SP_ITEM   SP1:M:<intent>:<item_name>
//   SP_CONFIRM <intent>        settlement succeeded on Solana
//   SP_FAIL    <intent>        settlement failed
//   SP_WALLET  <address> <lamports>   provision this badge's wallet + balance
//   SP_ID                      ask the badge to announce its identity
//
// SP_WALLET is how the sender gets its balance. The Lua app had these values
// injected into its source at install time; native firmware stores them in NVS
// instead, so a sender provisioned once over USB keeps them on battery.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    void (*on_intent)(const char *packet, void *ctx);   // full SP1:I:... line
    void (*on_item)(const char *packet, void *ctx);     // full SP1:M:... line
    void (*on_confirm)(const char *intent, void *ctx);
    void (*on_fail)(const char *intent, void *ctx);
    void (*on_wallet)(const char *address, uint64_t lamports, void *ctx);
    void (*on_id_request)(void *ctx);
    void *ctx;
} spconsole_cbs_t;

void spconsole_init(const spconsole_cbs_t *cbs, const char *role);

// SP_EVT|v=3|seq=..|role=..|type=<kind>|<fields>. fields may be NULL.
void spconsole_emit(const char *kind, const char *fields);
// The approval line the laptop settles on. Unchanged from the Lua apps.
void spconsole_approval(const char *intent, const char *badge_id, const char *nonce);
// SOLARPAY_BADGE:<role>:<badge_id> -- the identity line the website parses.
void spconsole_identity(const char *role, const char *badge_id);
// True while the laptop has spoken to us recently.
bool spconsole_laptop_online(void);

#ifdef __cplusplus
}
#endif
