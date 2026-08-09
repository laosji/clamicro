# Clamicro

[中文](./README.zh-CN.md)

Watch Claude Code from your phone, and approve what it wants to run.

Stop babysitting the terminal. When Claude Code needs permission, your Mac notifies you; open the page on your phone, read the command and a one-line summary, swipe to approve or reject — Claude Code continues immediately.

**Be clear on the default before you assume it gates everything: ordinary operations wait 10 seconds, then approve themselves.** What actually waits for you is high-risk work — `rm -rf`, force pushes, anything touching `~/.ssh` — and those wait until they time out and are then **auto-denied**. So out of the box it *tells you* about routine work and *stops* dangerous work. Set the 10 seconds to 0 in settings if you want every single operation to wait for you.

**Zero dependencies.** Node ≥ 18 and `curl` (built into macOS). Nothing in `node_modules` at runtime.

> macOS + iPhone only. The service uses macOS-specific facilities (`scutil`, `osascript`, Bonjour) and the UI is built for iOS Safari.

---

## Install

```bash
npx clamicro install
```

Two steps:

1. **In the terminal** — checks your environment, shows exactly what it will change in `~/.claude/settings.json`, waits for your confirmation, backs up and writes, asks whether to trust the current network, starts the service, prints a QR code.
2. **Scan with your phone** — tap "Send a test approval" and approve it for real. That round-trip *is* the acceptance test.

It works immediately after install: when approval is needed your Mac shows a notification and plays a sound, the terminal status line shows `⏳ N pending`, and the web UI is reachable from your phone.

**No remote push:** the only alert channel is a macOS local notification — fully offline. Nothing will reach you once you walk away from the Mac; high-risk operations sit until they time out and get rejected. See "Near-field means Wi-Fi only" below.

> The installer **appends, never replaces.** Your existing hook config is preserved intact; if `statusLine` is already taken by another tool it's left alone with a warning. Everything is backed up first.

Uninstall:

```bash
npx clamicro uninstall
```

Removes only what it added — verified byte-for-byte identical to the pre-install config. Config and history stay in `~/.claude/clamicro/` for you to delete manually.

### Where the runtime lives

The npm package is **just an installer**. Runtime files are copied to `~/.claude/clamicro/app/`, and hooks point there.

This isn't busywork. Hooks store absolute paths, but `npx` runs from a cache directory that changes, and global install paths move with your node version / nvm / homebrew. Pointing hooks at the package means that one day the path breaks and **every hook fails silently** — no error, you simply stop being notified. Verified: delete `node_modules` and the service and hooks keep working.

To upgrade, run `npx clamicro install` again.

---

## What you get

| On your phone | Source |
|---|---|
| Session state and sub-state (Thinking / Searching / Editing) | hook event stream |
| 5-hour and 7-day usage, context window, session cost | `statusLine` |
| Pending approvals with a plain-English summary and impact tags | `PermissionRequest` |
| Task finished / errored alerts | `Stop` / `StopFailure` |
| Full event timeline per session | all hooks |
| Pause / Resume / Cancel the current turn | `PreToolUse` gate |
| Quota-nearly-exhausted warning | `statusLine` |

### Gestures

Swipe left to reject, right to approve — on both the detail page and the home list. Approvals get a 3-second undo window.

High-risk operations (`rm -rf`, `git push --force`, key and credential files, writes outside the working directory) need a longer swipe on the detail page, and **can't be approved by swiping in the list at all**. The list is for fast triage; letting something dangerous through should require opening it and looking.

### What "pause" actually means

Claude Code has no runtime-freeze primitive — nothing can stop it mid-step. "Pause" **holds it at the next tool call**; the step currently running finishes first. The UI says so explicitly, so you don't think the button did nothing. Cancel works the same way, returning `{continue: false}` at the next gate.

### The approval path

```
Claude Code wants to run something that needs permission
  → PermissionRequest hook (HTTP, timeout 600)
  → service records it, your Mac notifies you, then it blocks
  → you approve or reject on your phone
  → hook returns the decision → Claude Code proceeds or is denied
```

---

## Security

This tool hands Claude Code's execution permissions to your phone, so the boundaries are worth stating plainly.

### Network trust gate

The service is exposed on your LAN only on networks **you've explicitly trusted**. On an unfamiliar network (café, airport, hotel) it binds to loopback only — your phone can't reach it — and your Mac tells you why.

```bash
npx clamicro networks   # current network + trusted list
npx clamicro trust      # trust the current network
npx clamicro untrust    # revoke — current network by default, or untrust <id-prefix> / untrust all
```

Trust is **revocable.** Trusting a network by mistake (tapping "yes" at a café) shouldn't be permanent — otherwise that network stays on the list forever and re-exposes you the next time you connect.

The fingerprint combines **gateway IP + gateway MAC + subnet**. SSID needs Location permission on recent macOS and is often unavailable; and `00:00:5e:00:01:xx` is a VRRP virtual MAC that is *not* unique across enterprise networks — matching on MAC alone would treat two different corporate networks as the same one.

### Implemented protections

| Protection | What it stops |
|---|---|
| **Host header allowlist** | DNS rebinding. A malicious site rebinds its domain to your LAN IP; the browser treats it as same-origin, CORS is bypassed entirely, and it can read your dashboard and command text and approve operations — **without ever being on your Wi-Fi** |
| **hooks / statusLine loopback-only** | Anyone on your subnet forging hook events: spamming approval notifications, injecting fake timeline entries, faking quota readings |
| **`/api/pair` requires a custom header** | CSRF. Cross-site "simple requests" are sent by the browser regardless — the side effect already happened — meaning any site you visit could make your Mac pop up a QR code |
| **CSP `frame-ancestors 'none'`** | Clickjacking: a malicious page framing the approval screen and tricking you into swiping |
| **Constant-time comparison** | Timing side channels on the token and per-approval keys |
| **`SameSite=Lax` + `HttpOnly`** | CSRF, while still keeping you logged in when arriving from another app (`Strict` would force a re-scan every time) |
| **Per-approval key** | A leaked deep link can only decide that one approval, and expires with it |

### In plain terms: that QR code is a key to your Mac

**The token behind it grants permission to approve anything** — `rm -rf`, `sudo`, reading your `~/.ssh/id_rsa`. Treat it like a password:

- Don't leave the QR on screen where someone can photograph it; don't screenshot it into a group chat
- If you suspect it leaked, rotate immediately: `npx clamicro rotate-token` (every logged-in device is signed out at once)
- The login cookie expires after 30 days; scan again then

### The remaining risk: plaintext HTTP

LAN traffic is unencrypted. **A passive sniffer on the same network can capture your token** and gain full control, including approving `rm -rf`. Command text is equally exposed.

There's no fix that preserves the scan-and-go experience — a self-signed certificate makes Safari throw warnings and breaks the flow. The network trust gate downgrades this from "remember not to use it at a café" to "it doesn't work there by default." But if you genuinely need this on an untrusted network:

**Use Tailscale.** WireGuard end-to-end encryption, no third party ever sees plaintext, and it isn't limited to one Wi-Fi. The service detects `100.64/10` addresses and binds to them automatically, **bypassing the trust gate** — an encrypted overlay doesn't care what physical network it sits on.

The other route is a tunnel (`clamicro tunnel on`), but tunneling services terminate TLS and can technically read your command text — so it's an escape hatch, not a default.

---

## Near-field means Wi-Fi only

The control plane **never leaves your LAN**. Command text, approval decisions, timeline and quota all go straight to `http://<host>.local:8765`.

Two tiers based on where you are — neither reaches outside:

| Situation | How you're alerted | Network reach |
|---|---|---|
| **① At your Mac** | macOS notification + sound | **fully offline** |
| **② Away from the Mac** | **no alert** | — |

**Why ② has no alert:** lock-screen-capable notifications must go through APNs, which necessarily means a third-party server.

Two channels were tried and both removed: an ntfy relay with action buttons (approve straight from the lock screen — that hands the *control plane* to a third party), and Bark (one line saying "there's an approval", control plane staying on the LAN). The latter was about as restrained as it gets, and it still only bought "something can page you while you're away" — but this tool assumes you're nearby to begin with. Continuously telling an outside server that an operation is waiting for approval isn't worth that.

**Be clear about the cost:** once you leave the Mac, *nothing* alerts you. High-risk operations wait out the timeout (570s by default) and get auto-rejected, failing that turn. That is the intended default — nobody should be approving `rm -rf` while away. You can still open the dashboard from your phone whenever you want to look.
---

## Design notes

**Hooks must respond before pushing.** `async: true` only works for `command` hooks; HTTP hooks always block for the response. So every endpoint returns `{}` immediately and pushes afterwards.

**570-second self-timeout returning deny.** Never let it reach the system's 600s timeout — that's treated as a non-blocking error and falls through to the normal permission flow, leaving the terminal hanging on a prompt nobody is looking at.

**Five terminal states:** `allowed` / `auto_allowed` / `denied` / `expired` / `abandoned`. When the same approval is decided from multiple places, first write wins and later ones get the real current state instead of an error.

**`Stop` push threshold.** `Stop` fires at the end of *every* assistant turn, including two-second exchanges. Only turns ≥ 30s notify by default. When the turn's start time is unknown (service started mid-session) it notifies anyway — better one extra ping than a missed completion.

**Operations that will auto-approve don't notify at all.** Your phone buzzes, you pull it out, unlock — the 10 seconds are long gone. That notification is pure noise; the operation was pre-authorized and shouldn't interrupt anyone.

**The status line is rendered server-side.** `bin/statusline.sh` doesn't parse JSON — it POSTs the payload and gets rendered text back. No `jq` dependency, and no ~115ms Node startup cost (measured: 15ms). It shows `⏳ N pending` when approvals are waiting.

**Sub-states are derived, not events.** Claude Code has no Thinking/Searching/Editing events; they're inferred from `PreToolUse.tool_name`, with the gap between `PostToolUse` and the next `PreToolUse` treated as Thinking.

**A dead service never blocks Claude Code.** A refused loopback connection is instant; the hook gets a non-blocking error and proceeds. And `SessionStart` is a `command` hook that starts the service before forwarding — opening Claude Code means the service is up.

**The address is a Bonjour hostname, not an IP.** macOS already broadcasts `<LocalHostName>.local`; using it means old links survive DHCP changes and you never re-scan. If your router blocks multicast, set the address mode to IP in Settings.

**The login cookie must be `SameSite=Lax`, not `Strict`.** Arriving from another app (a saved link, the QR shown on the Mac) is a cross-site navigation; `Strict` cookies aren't sent, so every notification tap would look like a fresh login.

**Quota is account-level, not per-session.** Storing it per session lets a stale session's numbers override the newest reading. Only the latest observation counts, and the UI shows when it was taken and from which session.

**Approvals and events are persisted** to `~/.claude/clamicro/history.json` — debounced writes, atomic rename. Anything still pending at restart becomes `abandoned`: those hook connections are long gone, and showing them as "waiting" would be a lie.

**Hooks hot-reload; statusLine doesn't.** Hook changes take effect in the current session; statusLine needs a new one.

---

## Commands

```bash
npx clamicro install      # install / upgrade
npx clamicro uninstall    # uninstall
npx clamicro qr           # print the login QR code
npx clamicro status       # service, network, version
npx clamicro trust        # trust the current network
npx clamicro untrust      # revoke trust (untrust <id-prefix> | untrust all)
npx clamicro networks     # current network + trusted list
npx clamicro rotate-token # issue a new access token (if it may have leaked)
npx clamicro test-push    # send a test notification (local, on the Mac)
npx clamicro logs         # tail the log
npx clamicro stop         # stop the service
```

You don't normally start it by hand — the `SessionStart` hook brings the service up when you open Claude Code.

Config lives at `~/.claude/clamicro/config.json` (mode 600, contains the token and push credentials). Day-to-day settings are editable from the phone UI; you shouldn't need to touch this file.

`ignoreCwds` lists working directories that skip blocking approval — useful when developing clamicro itself, and should be empty otherwise.

---

## Known limitations

- Requires the same Wi-Fi as your Mac (or the same tailnet); corporate networks with client isolation or VLAN separation won't work
- LAN traffic is plaintext — use Tailscale on untrusted networks, see [Security](#security)
- Plain HTTP isn't a secure context, so no Service Worker or Web Push
- macOS + iPhone only
- Pause means "stop at the next interceptable point", not a runtime freeze
- The interface is gesture-first; there's currently no equivalent path for VoiceOver users
- History keeps one day, capped at 300 approvals / 3000 events, oldest dropped

---

## Guide

A walkthrough covering first run, the three usage scenarios, how to read the approval screen, and troubleshooting: [docs/guide.md](./docs/guide.md) · [中文](./docs/guide.zh-CN.md)

---

## Notes

Maintainer notes — mistakes made and why decisions were taken the way they were: [NOTES.md](./NOTES.md) (Chinese).

---

## License

MIT
