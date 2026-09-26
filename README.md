# Pulse — Take-Home Assessment

Welcome, and thanks for taking the time. **Pulse** is a working (mostly!) Next.js
app: a living globe of anonymous strangers — every online user is a dot on a world
map; tap one to connect for text chat or a video call. No accounts, no history,
nothing stored. Coordination and WebRTC signaling run through the server
(Postgres + HTTP polling); chat and video are peer-to-peer over WebRTC.

You'll work through **four phases**. They're designed to be realistic, not trick
questions. We care as much about *how you think* as about what you ship — so a
short write-up is required (see **Deliverables**).

> **Using AI is allowed.** Use whatever tools you'd use on the job. The phases are
> built so that judgment, debugging, and product taste matter more than raw code
> generation. Please make the decisions yours and be ready to explain them.

---

## See it live

A working version is deployed at **https://pulse-silk-eta.vercel.app/**.

Because Pulse connects two strangers, you need **two participants** to try it: open
the link in **two separate browser windows** (e.g. a normal window + an
incognito/private window, or two different browsers). In each window's DevTools →
**Sensors**, set a different mock geolocation so the two dots land apart, then tap
one dot to connect, accept, chat, and start video.

---

## How it works

- **Coordination only** runs on the server: live presence and the WebRTC signaling
  handshake, stored transiently in **Postgres** (via Prisma) and delivered by short
  **HTTP polling** (no WebSockets — they don't work on Vercel serverless).
- **Chat and video are peer-to-peer** over **WebRTC** (data channel + media). They
  never touch the server, so messages and video are never seen or stored.
- The map is **Mapbox GL JS**. Each dot is placed 1–3 km from the user's real
  location, randomized fresh every session.

---

## Getting started

> ### ⚠️ Repository setup — please read this first
> **Clone this repository — do _NOT_ fork it.** Then create a brand-new **public**
> GitHub repository of your own and push your clone there. **Commit as you go** —
> we review your **git history and commit practice**, so use meaningful,
> incremental commits with clear messages (not one giant final commit). Your final
> deliverables are **your public repo URL** and a **live Vercel URL** — see
> **Deliverables** below.

### Local setup

1. Install deps (this repo uses [pnpm](https://pnpm.io); `corepack enable` will
   fetch the version pinned in `packageManager`):
   ```bash
   pnpm install
   ```
2. Copy `.env.example` to `.env` and fill in your own credentials:
   - A free Postgres database — [Neon](https://neon.tech) or Vercel Postgres.
   - A free [Mapbox token](https://account.mapbox.com/access-tokens/).
3. Create the tables:
   ```bash
   pnpm prisma db push
   ```
4. Run it:
   ```bash
   pnpm dev
   ```
   Open http://localhost:3000.

### Commands

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Next.js dev server on http://localhost:3000 |
| `pnpm build` / `pnpm start` | Production build / serve it |
| `pnpm check` | **Everything below, in order.** Stops at the first failure. |
| `pnpm lint` | [Oxlint](https://oxc.rs/docs/guide/usage/linter) (`.oxlintrc.json`) |
| `pnpm lint:fix` | Oxlint's safe autofixes |
| `pnpm format` | [Oxfmt](https://oxc.rs/docs/guide/usage/formatter) (`.oxfmtrc.json`) |
| `pnpm format:check` | Reports unformatted files, exits non-zero. For CI. |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm api-probe` | The Phase 3 API probe (`scripts/api-probe.mjs`) |

`pnpm check` runs `lint` → `format:check` → `typecheck` → `api-probe`. The first
three need nothing running. **The probe is an HTTP client, so it needs a running
server** — start `pnpm dev` in another terminal first, and `check` will tell you
if nothing is listening. Extra arguments go to the probe:

```bash
pnpm check -- --skip-abuse        # skip the rate-limit sections
pnpm check -- https://your-deployment.vercel.app
```

### Testing with two users

WebRTC needs two participants. Open the app in two browser profiles (e.g. a normal
window + an incognito window). In each tab's DevTools → **Sensors**, set a
different mock geolocation so the dots land apart, then connect.

> Connections use **STUN only** (no TURN), so a minority of strict/corporate
> networks won't establish a media connection — that's a known limitation, not
> something you need to solve.

> There is a note in `AGENTS.md` about this codebase. Please read it.

---

## The phases

(See the email for time expectations.)

### Phase 1 — Make it run
The app does not currently work end-to-end. There are several bugs in here — find
and fix each one until two users can reliably see each other on the map, connect,
chat, and start a video call.

As **one example** of the kind of thing you'll run into:

> "I tested with a friend. After we both closed the app, our dots stayed on the
> map for ages — it kept looking like people were online when nobody was."

That's one bug. **There are more** — this is just an example to show the flavor.
Track down and fix each issue you find.

### Phase 2 — Make it good
This phase is all about **UI/UX**. Make Pulse genuinely *beautiful* — something
you'd be proud to show off and that people would actually want to use. There's no
mockup and no rules: restyle anything, add motion and polish, rethink the layout,
tighten the flow, sweat the details. **Use your creativity and make this app
gorgeous.** We're looking at your sense of design, taste, and product feel — go
make it stunning.

### Phase 3 — Make it secure
Review the API before shipping. Identify the issues you'd want fixed before this
went live, prioritize them, and address what you can.

### Phase 4 — Make it better
Build something **new** that makes Pulse feel more **alive** and/or **safe** — and
that genuinely impresses us. Add a unique feature or capability of your own design:
something creative and original that makes the app stand out and that you'd want a
reviewer to remember. There's no spec and no right answer — the idea is entirely
yours. Surprise us, ship it working, and explain your thinking in your notes.

---

## A note on sequencing

Phases **2 and 4** can be attempted at any time. Phase **3** (security review)
assumes a running app, so it's most natural after Phase 1.

---

## Deliverables

1. **A public GitHub repository.** **Clone** this project (do **not** fork it) and
   push it to a brand-new public repo of your own. Commit as you go — we review
   your **git history and commit practice**, so meaningful, incremental commits
   with clear messages matter.
2. **A live Vercel deployment.** Deploy your finished app and include the URL so we
   can test it end-to-end. Set the same env vars from `.env.example` in the Vercel
   project settings, and run the Prisma schema against your database.
3. **A `NOTES.md`** at the repo root with a short section per phase:
   - **Phase 1:** what was broken, how you found it, how you fixed it.
   - **Phase 2:** what you changed and the thinking behind it.
   - **Phase 3:** the issues you found, how you'd rank them, and what you fixed.
   - **Phase 4:** what you built, why, and what you'd do next with more time.

Submit the **repo URL** and the **Vercel URL**. Keep `NOTES.md` concise — bullet
points are fine. We read it closely.

---

## Ground rules

- Use any libraries, tools, or AI assistance you like.
- Don't worry about pixel-perfect polish or 100% completeness — we're looking at
  judgment, problem-solving, and how you make trade-offs.
- If something is ambiguous, make a reasonable call and note your assumption.
- Do optimization you want, its your decision to make.

Good luck — have fun with it.

---

## How it's scored

| Phase | Weight |
|-------|--------|
| Phase 1 — Make it run | 15% |
| Phase 2 — Make it good | 30% |
| Phase 3 — Make it secure | 20% |
| Phase 4 — Make it better | 30% |
| Engineering practice & delivery | 5% |
