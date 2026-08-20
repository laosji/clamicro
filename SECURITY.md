# Security Policy

Clamicro decides whether a command runs on your machine. It holds a credential, binds a
listener to your LAN, and its worst failure is *silent approval*. Please treat anything
that weakens that as a security issue, not a bug.

（中文报告完全可以，不用翻译成英文。）

## Reporting a vulnerability

**Use GitHub's private reporting — don't open a public issue.**

Go to the repository's **Security** tab → **Report a vulnerability**
([direct link](https://github.com/laosji/clamicro/security/advisories/new)). That channel is
private until an advisory is published.

Helpful to include: the version (`npx clamicro status` prints it), your macOS and Node versions,
and the smallest sequence of steps that reproduces it. A proof of concept is welcome but
not required — a precise description of the flawed reasoning is often enough.

This is a single-maintainer project. There is no response SLA. Expect a first reply within
about a week; if a week passes with no reply, feel free to ping via a public issue that
says only *"sent a private report, no reply yet"* — with no details.

## Supported versions

Only the latest published version on npm gets fixes. Releases are frequent; there are no
maintained backport branches. If you're reporting against an older version, please confirm
it still reproduces on the latest one when you can.

## What is in scope

Anything that lets an operation run without the approval it should have needed, or lets
someone who isn't you make that decision:

- Recovering, forging, or replaying the pairing credential or a session token
- Bypassing the pairing confirmation (the Mac-side Allow dialog) to enrol a device
- Forging or replaying an approval decision, or attributing one to the wrong device
- Getting the risk classifier to score a dangerous operation as ordinary — this matters
  more than it sounds: ordinary operations **auto-approve after 10s**, so a misclassified
  `rm -rf` is an unattended approval, not merely a wrong label
- Anything that makes the hooks silently stop gating while the UI still looks healthy
- Reading approval contents, command text, or history from another device on the LAN
- Escaping the LAN: any path where control-plane data reaches a host outside it

## What is out of scope

These are deliberate design choices, documented in the README. Reports about them will be
closed as working-as-intended — though arguments that a choice is *wrong* are welcome as
ordinary issues.

- **No alerts once you leave the Mac.** Lock-screen-capable push requires a third party;
  both an ntfy relay and Bark were built and removed on purpose. High-risk operations time
  out and auto-deny instead. See "Near-field means Wi-Fi only".
- **The service is visible on your LAN.** It binds a LAN interface by design — that is how
  your phone reaches it. Discovering that a Mac runs Clamicro is not a vulnerability.
- **Physical access to an unlocked, paired Mac or phone.** Out of scope, as everywhere.
- **Ordinary operations auto-approving after 10s** with correct classification. That is the
  documented default, adjustable to 0 in settings.
- **`npx clamicro install` writing to `~/.claude/settings.json` and `~/.dsh/profiles`.** It
  shows the diff, asks first, backs up, and appends rather than replaces.

## The failure mode that matters most

This project's design notes keep returning to one idea: the dangerous failure is not a
crash, it is **something going wrong while the interface reports that everything is fine.**

A real example, already fixed: risk assessment once matched `toolName === 'Bash'`, and
DeepSeek Harness names its tool lowercase `bash` — so the entire high-risk ruleset never
ran, and `rm -rf /` was scored ordinary and auto-approved after 10 seconds, with no error
anywhere.

If you find anything shaped like that — protection quietly not applying, while the phone
and the terminal both look normal — that is the highest-value report you can send.
