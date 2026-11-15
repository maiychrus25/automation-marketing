# fbchat-v2 :: bridge-e2ee

Standalone Go binary that handles Facebook Messenger E2EE (Secret Conversations
/ Labyrinth) and exposes a tiny line-delimited JSON RPC over stdin/stdout. The
Python listener (`src/_messaging/_listening_e2ee.py`) launches this binary as a
subprocess.

This package is fully independent from the `meta-messenger.js/` folder. The
underlying Go code (Signal Protocol via `whatsmeow`, Meta protocol via
`mautrix-meta`) is the same - there is no pure-Python alternative.

## Build

You need Go ≥ 1.24 installed (https://go.dev/dl/).

```powershell
cd fbchat-v2/bridge-e2ee

# 1. fetch the mautrix-meta source (referenced by go.mod via `replace`)
git clone https://github.com/mautrix/meta.git ./meta

# 2. download deps and build
go mod tidy
go build -ldflags="-s -w" -o ../build/fbchat-bridge-e2ee.exe .
```

On Linux/macOS:

```bash
go build -ldflags="-s -w" -o ../build/fbchat-bridge-e2ee .
```

## Where Python looks for the binary

The Python wrapper looks in this order:

1. `$FBCHAT_E2EE_BIN` environment variable
2. `fbchat-v2/build/fbchat-bridge-e2ee[.exe]` (relative to the package)

## Protocol

Request (one JSON object per line):

```json
{"id": 1, "method": "newClient", "params": {"cookies": {...}, "platform": "facebook"}}
```

Response:

```json
{"id": 1, "ok": true, "data": {"ready": true}}
```

Async event (no id):

```json
{"event": {"type": "e2eeMessage", "data": {...}, "timestamp": 1715508423000}}
```

Methods: `newClient`, `connect`, `connectE2EE`, `isConnected`, `sendMessage`,
`sendE2EEMessage`, `fetchMessages`, `markRead`, `getUserInfo`, `disconnect`.

`fetchMessages` loads one page of older messages for a thread:
`{"method":"fetchMessages","params":{"threadId":"123","beforeTimestampMs":0,"beforeMessageId":"","timeoutMs":25000}}`
returns `{threadId, messages (newest first), hasMoreBefore, minTimestampMs, minMessageId}`.
Older messages that arrive for a waiting request, or up to 60 s after it ended (late answer), are not emitted as live message events. `timeoutMs` <= 0 uses 25 s; values above 60000 are capped at 60 s.

`markRead` sends a read receipt: `{"method":"markRead","params":{"threadId":"123","watermarkTs":1715508423000}}`
returns `{}`. `threadId` is a JSON string holding a positive decimal id (no `@...` suffix); `watermarkTs` (ms, >= 0) is optional.

`sendE2EEReaction` (`{chatJid, messageId, senderJid, emoji}`; empty `emoji` removes the reaction) stamps the
reaction with the send time (`SenderTimestampMS`). The official app orders reactions by it and silently
ignores a reaction without one.

`getUserInfo` looks a user up in Messenger's contact table: `{"method":"getUserInfo","params":{"userId":"123"}}`
returns `{id, name, firstName, username, profilePictureUrl, ...}` or fails with `user not found`. `userId` is a JSON string holding a positive decimal id.

E2EE device persistence: `newClient` takes an optional `deviceData` (the JSON string last published
in a `deviceDataChanged` event). A usable one is restored and `connectE2EE` skips registration; an
unusable one is replaced by a new device. Without `deviceData` and `devicePath` the device lives in
memory and changes emit `deviceDataChanged` (at most one per 100 ms; registration emits at once) with `{"deviceData": "<json>"}` (private keys: never
log it). `e2eeMemoryOnly` emits nothing. When Facebook logs the device out the bridge emits
`disconnected` with `{"isE2EE": true, "loggedOut": true}` and stops emitting `deviceDataChanged`.
One-time prekeys are derived from a per-device seed stored in that state (`pre_key_seed`), so they can
be recomputed after a restart; stored state without a seed is treated as unusable.

Decrypt diagnostics: whatever `logLevel` is (except `none`), whatsmeow's lines about a failed decrypt,
retry receipts and prekey counts are written to stderr as `<LVL> [whatsmeow] ...`, plus one
`INF [bridge] E2EE device ready device=<n> restored=<bool> registered=<bool>` line per `connectE2EE`.
They carry message and sender ids and error text, never keys or message content. A failed decrypt
never drops the device. libsignal's warnings and errors go to the same place as `<LVL> [libsignal] <file:line> ...`
(unconfigured, libsignal prints them to stdout, the JSON-RPC channel), and the store writes
`DBG [bridge] session put|get ...`, `identity ...` and `prekey ...` lines that identify stored bytes by
length and a 4-byte hash only. After each E2EE connect one `INF [bridge] E2EE self-check: ...` line
compares the bundle the server hands out for this device with the local keys (match/MISMATCH and ids).

Dependencies: `go.mau.fi/libsignal` must be 0.2.3 or newer. 0.2.2 verifies a message MAC over a
re-serialized copy of the message, which drops fields it does not know; the official Messenger app
now sends such fields, so 0.2.2 rejects every incoming message ("mismatching MAC").

Sibling device ids: `GetSession` returns the asked address's session plus, as previous states, the
sessions held with other device ids of the same user that present the same identity key. One install
registered under several device ids answers on whichever session it read last.

`message` events produced by Messenger's upsert (sync/backfill) batch carry `"isHistory": true`.

## Tests

```bash
cd src/bridge-e2ee
go vet . ./bridge/... && go test . ./bridge/...
```

Python wrappers exposed today:

- `_messaging._listening_e2ee.listeningE2EEEvent` - drives `newClient` →
  `connect` → `connectE2EE` and streams async events back to the caller.
- `_messaging._send_e2ee.api` - drives `sendE2EEMessage` (text only). Can
  reuse the listener's bridge process or spawn its own in standalone mode.

Methods present in `bridge/` but **not yet wired** through `main.go` /
Python: `sendReaction`, `editMessage`, `unsendMessage`, `sendTyping`,
`MxDownloadE2EEMedia`, `SendE2EEImage`, `SendE2EEVideo`,
`SendE2EEAudio`. To expose, add a `case "..."` in `handle(req)` of `main.go`
and rebuild.

## License

The `bridge/` directory contains code copied from
[meta-messenger.js](https://github.com/yumi-team/meta-messenger.js), © 2026
Yumi Team, AGPL-3.0. The `main.go` and Python wrapper are original.
