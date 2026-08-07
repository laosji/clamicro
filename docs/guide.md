# Clamicro Guide

[← back to README](../README.md) · [中文版](./guide.zh-CN.md)

---

## 1. Install

```bash
npx clamicro install
```

The terminal asks you three things:

**Should it edit `~/.claude/settings.json`?**

It shows you the exact changes first. Your existing hook config is untouched — new entries are appended, never substituted. A backup is written before anything changes.

**Should it trust the current network?**

For your phone to reach the service, the service has to be exposed on your LAN. LAN traffic is unencrypted, so only do this on networks you trust — home, your own hotspot. Not a café.

When you move to an unfamiliar network the service automatically retreats to loopback and waits for you to confirm again. That's protection, not a malfunction.

**Should it start at login?**

You don't need it. The `SessionStart` hook brings the service up whenever you open Claude Code. Only turn this on if you want to browse history from your phone while Claude Code isn't running.

A QR code is printed at the end.

---

## 2. First run — finish the loop or it isn't installed

Scan the QR with your phone camera; the browser opens the home screen.

You only log in once — the token becomes a cookie, valid for a year. After that just open the address directly.

**Two things worth doing right away:**

**Add to Home Screen.** Safari share menu → Add to Home Screen. It becomes an icon with no address bar, close to an app.

**Run the acceptance test.** Settings → "Send a test approval" at the bottom. It creates a fake pending approval for you to decide on — **approving or rejecting does not execute anything**. Completing that round-trip proves the whole chain works.

---

## 3. Day to day

### You're at your Mac

Nothing to configure. When permission is needed:

- your Mac shows a notification and plays a sound
- the terminal status line shows `⏳ 1 pending`
- it also appears on the phone web UI

Ordinary operations (`npm run build` and friends) **auto-approve after 10 seconds** — you never have to deal with them. Only high-risk operations wait for you.

### You've left the Mac, still on the same Wi-Fi

You need Bark for this, otherwise nothing can reach you.

Settings → Phone push → tap "Don't have it? Get it on the App Store" → install Bark → copy the key from its home screen → paste it back.

After that, high-risk operations ring your phone. Tapping the notification opens the approval screen.

> It works without Bark too — you just have to remember to open the page yourself. And high-risk operations will sit until they time out and get rejected, failing the task.

### You're on a different network

This doesn't work by default, deliberately. If you genuinely need it, install Tailscale — the service detects and binds to it automatically, bypassing the network trust gate. See [Security in the README](../README.md#security).

---

## 4. Reading the approval screen

The one screen that matters, top to bottom:

```
┌──────────────────────────────────┐
│ my-project  …/dev/my-project 8:42│  ← which session, time left
├──────────────────────────────────┤
│                                  │
│  [Bash] [writes files] [rule Bash]│ ← tool + impact + matched rule
│                                  │
│  Clean build output and force-push│ ← one plain sentence — the star
│                                  │
│  ⚠️ High-risk operation           │  ← only shown for high risk
│  recursive delete · force push    │
│                                  │
│  ▸ View full command (3 lines)   │  ← raw text collapsed by default
│                                  │
│  ← swipe to reject · high risk, swipe further to approve → │
│  ━━━━━━━━━━━━━  auto-reject in 8:42│ ← what happens if you do nothing
└──────────────────────────────────┘
```

**Read the plain sentence, not the raw command.** It comes from Claude Code's own description of what it's doing.

**Impact tags** (read-only / writes files / network / sudo) are extracted from the command. You can judge without expanding the raw text — `ls` and `rm -rf /` no longer look alike.

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

---

## 7. Troubleshooting

### Can't open it on my phone

In order:

1. **Same Wi-Fi as the Mac?**
2. **Is the network trusted?** — `npx clamicro networks`, then `npx clamicro trust`
3. **Is the service running?** — `npx clamicro status`
4. **Right address mode?** — if the address is `xxx.local` and your router blocks multicast, it won't resolve. Settings → Address, the page **tests it from your phone** and tells you; switch to IP if it fails

### No notifications

- Does the home screen show "🔕 Phone push is off"?
- Is "Enable phone push" on, and is the Bark key filled in?
- Tap "Send a test notification" to check directly
- **Note**: operations that will auto-approve **deliberately don't notify** — 10 seconds is gone before you could look

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
| **Bark Key** | Push credential. Optional — without it you just won't be alerted away from the Mac |
| **Show full command in push** | Off by default. When off, the outside world only sees "Bash operation (high risk)"; the command text stays on the LAN page |
| **macOS notification** | Your Mac makes the noise when you're near it. Fully offline |
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
