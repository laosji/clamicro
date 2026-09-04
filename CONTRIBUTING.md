# Contributing

## Reporting something

If the installer didn't get you to a working phone, that's the most useful report
this project can receive — there is no telemetry, so a stuck user who leaves is
invisible. Run:

```bash
npx clamicro doctor
```

It checks the seven install steps in order, names the first one that's broken, and
prints a redacted block you can paste straight into an issue. No token, no home
directory path, no SSID, no device names, only the network part of your LAN IP.
The rules are in [`src/doctor.mjs`](./src/doctor.mjs) if you want to read them
before pasting.

Then open an issue: [install problems](https://github.com/laosji/clamicro/issues/new?template=install-stuck.yml)
· [something behaves wrong](https://github.com/laosji/clamicro/issues/new?template=bug.yml)

Issues in Chinese are fine. So are ones that say "I gave up at step 5 and I'm not
sure why" — that is still the single most useful sentence you can send.

## Working on the code

```bash
node --test test/*.test.mjs
```

Zero runtime dependencies, and it stays that way: Node ≥ 18 and `curl`, nothing in
`node_modules` at runtime. Tests use only `node:test`.

While developing clamicro itself, put the project directory in `config.ignoreCwds`
so you aren't approving your own commands on every tool call — otherwise a
high-risk command will block for the full timeout while nobody is watching a phone.
**Empty it before you commit**; `npx clamicro status` lists those directories in
yellow because they are a complete bypass.

## Three rules the code actually enforces

These aren't style preferences — each one exists because it broke once.

**Silent failure is a bug, including silence about not doing something.** A button
that reports success while nothing happened is worse than a visible error. If a
capability isn't available on a backend, don't draw a disabled control — draw
nothing, and have the server refuse it too. A sent message looks more like success
than a greyed-out button does.

**The interface must not say something the code contradicts.** "Cancel this turn"
became "Cancel next step" because it intercepts the next tool call and can't touch
a turn that calls no tools. Prefer a longer name over a name that lies. Docs count
as interface: `test/docs.test.mjs` pins the timeout default, the auto-approve
window, the cookie lifetime, and that every `npx clamicro …` command in the docs
still exists in `cli.mjs`.

**Record why something *wasn't* done.** [`NOTES.md`](./NOTES.md) is chronological;
[`docs/architecture.zh-CN.md`](./docs/architecture.zh-CN.md) §6.5 holds the current
shape of each screen plus a table of rejected designs. Before adding UI, check
whether it's already in that table and whether the reason still holds. Reversing a
past decision is fine — reversing it without knowing it was made is not.

## Security

The threat model, what's protected and what explicitly isn't, is in
[SECURITY.md](./SECURITY.md) and the Security section of the README. Two things to
know before adding an endpoint:

- `/hooks/*` and `/statusline` must accept loopback only — they carry no token
- every page is behind the global Host allowlist, but a new **unauthenticated**
  endpoint needs its own CSRF reasoning
