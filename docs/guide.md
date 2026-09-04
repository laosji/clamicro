# Clamicro Guide

[← back to README](../README.md) · [中文版](./guide.zh-CN.md)

---

## 1. Install

```bash
npx clamicro install
```

The terminal asks you two things:

**Should it edit `~/.claude/settings.json`?**

It shows you the exact changes first. Your existing hook config is untouched — new entries are appended, never substituted. A backup is written before anything changes.

**Should it trust the current network?**

For your phone to reach the service, the service has to be exposed on your LAN. LAN traffic is unencrypted, so only do this on networks you trust — home, your own hotspot. Not a café.

When you move to an unfamiliar network the service automatically retreats to loopback and waits for you to confirm again. That's protection, not a malfunction.

That's all it asks. **There is no start-at-login option** — the service follows Claude Code: the `SessionStart` hook brings it up when you open Claude Code, and when Claude Code is closed there's no reason for it to be running. One less thing living in the background.

(Earlier versions registered a LaunchAgent. Upgrading from those removes it automatically — nothing to do by hand.)

**If DSH or Codex is detected, install only mentions it — it does not wire it up.** That writes into another product's own config file, so it gets its own command, run by you: `npx clamicro connect dsh` or `npx clamicro connect codex`.

At the end it prints **a URL**, plus a QR code of that URL (if `qrencode` is installed). That QR carries no credential — it is the same thing as the line of text under it, and only saves you typing an IP and port on a phone keyboard.

---

## 2. First run — finish the loop or it isn't installed

**1. Open that URL on your phone**, on the same Wi-Fi as the Mac. Scanning the QR in the terminal is the quickest way.

What opens is the **pairing page**, not the home screen — this phone holds no credential yet.

**2. Tap "Show QR on the Mac".**

The QR appears **on the Mac's screen only**, never on the phone page. Scan it with your phone's **Camera app**, pointed at the Mac.

(The pairing page can't scan: plain HTTP isn't a secure context, so `navigator.mediaDevices` is simply `undefined` in iOS Safari. The native camera is the only route — and the better one; it opens a Safari tab straight away.)

**3. Back on the Mac, press "Allow" in the dialog.**

It shows which device is asking and where the request came from. Nothing is issued until you press Allow — **seeing the QR is not enough**.

**4. Once paired, the phone lands on the onboarding screen**, which has exactly one thing on it: **Send a test approval**.

Tap it and decide one on your phone — **approving or rejecting does not execute anything**. Completing that round-trip proves the whole chain works. That *is* the acceptance test.

---

The login is stored as a cookie, valid for **30 days**; scan again when it expires. After that just open the address directly.

**One thing worth doing right away: Add to Home Screen.** Safari share menu → Add to Home Screen. It becomes an icon with no address bar, close to an app.

---

## 3. Day to day

### You're at your Mac

Nothing to configure. When permission is needed:

- your Mac shows a notification and plays a sound
- the terminal status line shows `⏳ 1 pending`
- it also appears on the phone web UI

Ordinary operations (`npm run build` and friends) **auto-approve after 10 seconds** — you never have to deal with them. Only high-risk operations wait for you.

### You've left the Mac

**Nothing will alert you.** That's deliberate — the only channel is a macOS local notification, and it doesn't leave your machine.

So:

- you have to remember to open the page on your phone yourself
- high-risk operations wait out the timeout (3 minutes by default) and are **auto-rejected**, failing that turn

The second one sounds harsh, but the direction is right: while you're away, `rm -rf` should not get through.

> Earlier versions had remote push (ntfy, then Bark). Both were removed. Lock-screen-capable notifications must go through APNs, which necessarily means a third-party server — and all it bought was "something can page you while you're away", when this tool assumes you're nearby to begin with.

### You're on a different network

This doesn't work by default, deliberately. If you genuinely need it, install Tailscale — the service detects and binds to it automatically, bypassing the network trust gate. See [Security in the README](../README.md#security).

---

## 4. Reading the approval screen

The one screen that matters, top to bottom:

```
┌──────────────────────────────────┐
│ my-project  …/dev/my-project 8:42│  ← which session, time left
├──────────────────────────────────┤
│  [Bash] [reads secrets] [writes] │  ← tool + impact tags
│                                  │
│  ⚠️ High-risk operation           │  ← only shown for high risk
│  recursive delete · touches keys  │
│                                  │
│  ⚠️ Description doesn't match     │  ← claims read-only, isn't
│  Says "check build output", but   │
│  the command deletes recursively  │
│                                  │
│  cat ~/[.ssh/id_rsa] > /tmp/x    │  ← the command. Primary. Risky
│  && [rm -rf] ~/proj/build        │    fragments highlighted
│                                  │
│  MODEL'S DESCRIPTION              │  ← small and grey: whose words
│  check build output               │
│                                  │
│  ← swipe to reject · high risk, swipe further to approve → │
│  ━━━━━━━━━━━━━  auto-reject in 8:42│ ← what happens if you do nothing
└──────────────────────────────────┘
```

**Read the command.** It's at the top and expanded by default.

**For file writes, read the content instead.** Edit / Write calls aren't commands, so the
page lists the change line by line — additions in green, removals in red, with a `+12 −3`
tag for the size. Same reasoning as the command text: this is what the operation actually
does, and the only part not narrated by the model. (Before, this section showed a file
path and nothing else — you were asked to approve something you couldn't see.)

Long content is truncated, but **the truncation is always stated** — a line underneath
tells you how many lines were left out. Context lines that are byte-identical on both
sides get trimmed as well, and that count is shown too; nothing is hidden by the trimming,
since both sides carried the same text.

**The model's description sits below it, in smaller grey type** — deliberately. That sentence is written by Claude Code itself: the one piece of text in this whole chain authored by the thing being reviewed. It can disagree with the command, so it doesn't get the primary slot. When it genuinely disagrees, the page says so outright (the red box above).

**Risky fragments are highlighted** inside the command (`rm -rf`, `.ssh/id_rsa`) to point you at the part most worth looking at first.

But **highlighting is a hint, not a guarantee.** It is pattern matching over the
command text: `base64 -d | sh`, indirection through a variable, `curl … | sh`, or a
dangerous action hidden inside a script file will not be marked. No highlight doesn't
mean safe — it means no rule matched. What protects you is reading the command.

**Impact tags** (read-only / reads secrets / writes files / network / sudo / `+12 −3` change size) are extracted from the command or its arguments. When it can't tell, it says "impact unknown" — it will **not** pretend something is read-only.

**The countdown at the bottom** answers "what if I ignore this":

- green "auto-approve in…" = ordinary operation, released after 10 seconds
- grey "auto-reject in…" = high risk, waits for you, rejected on timeout

---

## 5. Gestures

| Action | Result |
|---|---|
| Swipe left | Reject |
| Swipe right | Approve |
| Swipe right on high risk | Must go further (~55% of the screen), and flicking doesn't count |
| Swipe right on high risk **in the list** | **Won't budge** — open the detail page |

At a certain point the stamp "locks in" — it scales up, inverts, and buzzes. **That is the commitment point**: release there and it executes. Release before it and the card springs back.

Approving gives you a **3-second undo window** with a full-screen countdown ring. Rejecting takes effect immediately with no undo — rejecting by mistake is the safe direction, just let Claude try again.

---

## 6. What else it does

**Timeline** — the Sessions tab, tap any session. You get the full stream for that session: prompts, every tool call, approval requests, completions, errors.

**Pause / Cancel** — at the bottom of the timeline page.

> "Pause" is not an instant freeze; Claude Code has no such capability. It **holds at the next tool call**, and the step currently running finishes. The UI says so explicitly.

**Send a message** — the Send tab. Pick a session, type a line.

> Also not instant. Hooks are one-way, and the only injection point is "when this turn ends". So what you write enters the conversation after that session finishes its current turn. Good for "I can see it going the wrong way, let me redirect it."

**Approve from the terminal** — when you're sitting right at the Mac, you shouldn't have to fetch your phone from another room:

```bash
npx clamicro pending          # list what's waiting, with "in N seconds it will ..."
npx clamicro approve          # approve when there's exactly one
npx clamicro approve 31454f39 # name a specific one
npx clamicro deny 31454f39
```

> **High-risk operations require the explicit id** — you can't approve one just because it happens to be the only one waiting. On the phone a high-risk approval takes a deliberate 55% swipe with no flick shortcut; the terminal needs equivalent friction, because if one entrance is looser than the other, people drift to the loose one. The full command is printed before the decision, so your scrollback keeps a record of what you approved.

---

## 7. Troubleshooting

### Can't open it on my phone

In order:

1. **Same Wi-Fi as the Mac?**
2. **Is the network trusted?** — `npx clamicro networks`, then `npx clamicro trust`
3. **Is the service running?** — `npx clamicro status`
4. **Right address mode?** — if the address is `xxx.local` and your router blocks multicast, it won't resolve. Settings → Address, the page **tests it from your phone** and tells you; switch to IP if it fails

### No notifications

There's only one channel — the macOS local notification — so there are only a couple of things to check:

- Does the home screen show a "🔕 All alerts are off" banner? Then it's switched off
- Settings → is "macOS notification" on? Tap "Send a test notification" to check directly
- In macOS System Settings → Notifications, is "Script Editor" / `osascript` allowed?

**Note**: operations that will auto-approve **do still notify** — you should know what ran on
your machine, even when nothing was asked of you. The notification is informational; the 10
seconds are usually gone before you can act on it. If you do want to intervene, opening the
approval's detail page **pauses the clock** and gives you the full timeout (3 minutes) to decide.
You can silence these entirely with `notifyAutoApproved: false` in the config file.

### Claude Code is stuck

Usually a high-risk operation waiting for approval while the notification didn't reach you.

`npx clamicro status` shows pending approvals, or just open the phone page.

To stop intercepting entirely: `npx clamicro uninstall` (removes only what Clamicro added).

### Usage numbers are wrong / stuck on old data

If the page says "⚠️ this is X hours old", **no session is reporting**.

Why: statusLine is read **when a session starts**. Sessions you had open before installing Clamicro — or before you changed its install path — will never report.

Fix: **open a new Claude Code session**.

### Switched Wi-Fi, or your IP changed

**Just start a new Claude Code session.** The service notices its bound address is stale, restarts onto the new one, and re-evaluates whether the current network is trusted.

Then regenerate the QR — the address changed, so old links are dead:

```bash
npx clamicro qr
```

### New phone / cleared browser data

```bash
npx clamicro qr
```

Scan again.

---

## 8. What the settings mean

| Setting | Meaning |
|---|---|
| **macOS notification** | The only alert channel, fully offline. Turning it off means total silence |
| **Notification style** | Set `notify.style` in `config.json`: `notch` (default — a black capsule at the notch), `banner` (standard system notification), or `both`. **The trade-off: the notch capsule never reaches Notification Center.** It slides away and is gone; if you weren't at the screen, it may as well not have happened. Use `banner` or `both` if you want a record |
| **Notify on task completion** + minimum duration | `Stop` fires every turn, including two-second exchanges. Default: only tasks over 30 seconds |
| **Auto-approve ordinary operations** + wait time | 10 seconds by default. You can reject at any point during it |
| **Auto-approve high-risk too** | ⚠️ Off by default. Turning it on means `rm -rf` gets released while you aren't looking — exactly what approval exists to prevent |
| **Address mode** | IP (always works) / hostname (survives IP changes). The page tests from your phone and recommends |

---

## 9. Removing it

```bash
npx clamicro uninstall
```

Removes only what it added; your existing hook config is preserved and backed up first.

Config and history stay in `~/.claude/clamicro/` — delete that directory to clear everything.
