# Badge-to-badge end-to-end tests

Drives two physical badges through the whole Sender ↔ Merchant flow from a
laptop, and asserts on what the firmware actually reports rather than on what
the screens appear to show.

## Why a firmware harness exists

The two acts that move money — knocking the badges together and pressing A —
have no injection point. Pairing is gated on bilateral impact correlation fed
from the accelerometer (`splink_feed_impact`), and approval is reachable only
from a real A press while `SPLINK_PAIRED`. Without a harness the flow cannot be
exercised at all without a pair of hands, which caps testing at a handful of
manual runs.

So `CONFIG_SOLARPAY_TEST_HARNESS` adds three console commands:

| Command | Effect |
|---|---|
| `SP_TEST_IMPACT <mg>` | calls `splink_feed_impact()` — the same entry point the accelerometer uses |
| `SP_TEST_BTN <A\|B\|HOME\|LEFT\|RIGHT\|…>` | calls `on_button()` — the same entry point the 74HC165 poller uses |
| `SP_TEST_STATE` | emits one `SP_EVT type=test_state` line carrying the full model |

These enter through the same functions the real drivers call, so the pairing
correlation, the state machine, the ESP-NOW radio and the console contract are
all genuinely under test.

**What this does not cover:** the accelerometer driver and the 74HC165 button
driver are bypassed, and nothing here looks at the screen. A synthetic press is
also timed differently from a real one — `SP_TEST_BTN` fires PRESSED and
RELEASED back to back, where hardware goes through a 3-sample debounce at 10 ms.
Anything touching debounce, impact thresholding against real noise, or rendering
still needs a manual pass on real hardware.

## Safety

The harness is `default n` and must stay that way: a build with it enabled lets
anything that can write to the USB console approve a payment. It is turned on
only through `firmware/solarpay/sdkconfig.test`, never `sdkconfig.defaults`, and
a badge running it logs a warning and emits `SP_EVT type=test_harness` at boot.

## Running

```bash
npm run badge:build:test                    # build with the harness enabled
cd firmware/solarpay
idf.py -p /dev/cu.usbmodem101  flash        # sender
idf.py -p /dev/cu.usbmodem1101 flash        # merchant
cd -
npm run badge:e2e                           # one pass
npm run badge:e2e:soak                      # five passes
node tools/e2e/run.js --only pair           # scenarios matching "pair"
E2E_TRACE=1 npm run badge:e2e               # echo every serial line
```

Ports default to `/dev/cu.usbmodem101` (sender) and `/dev/cu.usbmodem1101`
(merchant); override with `SENDER_PORT` / `MERCHANT_PORT`.

Both badges must be owned exclusively by the harness. Chrome's Web Serial
connection holds the port open — disconnect the badge in the web page first, or
the run fails at preflight. Two processes driving one badge produces results
that look like firmware faults and are not.

## Layout

- `rig.js` — one `Badge` per port: line parsing, event waiting, `state()`,
  `until()`, `reset()` via esptool, and `knock()` which feeds both badges a
  correlated impact.
- `scenarios.js` — the scenarios. Each returns both badges to the home screen
  first, so one test's leftovers never explain the next one's result.
- `run.js` — the runner: preflight, loops, heap accounting, summary.

Tests wait on events rather than sleeping, so a slow radio makes a run slower
rather than flaky.
