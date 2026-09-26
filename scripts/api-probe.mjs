// Phase 3 API probe. Drives the coordination API over HTTP exactly like a
// malicious client would, and prints a pass/fail line per check.
//
//   node scripts/api-probe.mjs [baseUrl]

import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const BASE = args.find((arg) => !arg.startsWith("--")) ?? "http://localhost:3000";
// The abuse section needs the rate limiter; `--skip-abuse` runs the rest.
const SKIP_ABUSE = args.includes("--skip-abuse");

// Vercel overwrites x-forwarded-for, so this only means anything when the probe
// runs against a local server — which is the only place it runs. It exists so
// that (a) each run of this script is its own "client" and does not collide with
// the previous run's join budget, and (b) the per-address limits can be tested
// deliberately. 203.0.113.0/24 and 198.51.100.0/24 are the documentation ranges.
const RUN_IP = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
const ABUSE_IP = "198.51.100.7";

// A well-formed but wrong session token: 43 base64url characters.
const fakeToken = () => randomBytes(32).toString("base64url");

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n== ${title}`);
}

const uuid = () => crypto.randomUUID();

// Two helpers that reach into the coordination store directly, because the
// thing under test is a *time* limit that no HTTP client can reach.
const DB = process.env.DATABASE_URL_UNPOOLED;
async function sql(fragments, ...values) {
  const { neon } = await import(
    "/Users/zomeru/Desktop/Pulse-Technical-Assessment/node_modules/@neondatabase/serverless/index.mjs"
  );
  const client = neon(DB);
  return client(fragments, ...values);
}
const ageConnection = (connectionId) =>
  sql`UPDATE "Presence" SET "connectionStartedAt" = now() - interval '2 hours' WHERE "connectionId" = ${connectionId}`;
const expireLease = (connectionId) =>
  sql`UPDATE "Presence" SET "connectionExpiresAt" = now() - interval '1 second' WHERE "connectionId" = ${connectionId}`;
async function leaseOf(id) {
  const rows = await sql`SELECT "connectionExpiresAt" FROM "Presence" WHERE id = ${id}`;
  return rows[0]?.connectionExpiresAt
    ? new Date(rows[0].connectionExpiresAt).getTime()
    : 0;
}
async function presenceOf(id) {
  const rows = await sql`SELECT "busy", "connectionId", "peerId" FROM "Presence" WHERE id = ${id}`;
  return rows[0] ?? null;
}
async function waveRowsBetween(fromId, toId) {
  return sql`SELECT "type", "payload", "connectionId" FROM "Signal" WHERE "fromId" = ${fromId} AND "toId" = ${toId}`;
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "x-forwarded-for": RUN_IP,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body, headers: response.headers };
}

function post(path, body, headers) {
  return api(path, { method: "POST", body: JSON.stringify(body), headers });
}

async function join(lat = 51.5, lng = -0.12) {
  const id = uuid();
  const incarnationId = uuid();
  const result = await post("/api/join", { id, lat, lng, incarnationId });
  if (result.status !== 200) {
    throw new Error(`join failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return { id, incarnationId, token: result.body.sessionToken };
}

function poll(session, connectionId, ack) {
  const query = new URLSearchParams({ id: session.id });
  if (connectionId) query.set("connectionId", connectionId);
  if (ack) query.set("ack", ack.join(","));
  return api(`/api/poll?${query}`, {
    headers: { "x-pulse-session": session.token },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keep a set of sessions alive, the way the browser does.
 *
 * A presence row lives STALE_MS (15s) after its last heartbeat, which is the
 * product working: a dot outliving its owner was the Phase 1 bug. A test that
 * stops polling is therefore not testing a live session, it is testing a ghost,
 * and the wave sections below take long enough on a high-latency link for that
 * to matter. Anything the test still intends to speak with gets polled first.
 */
async function keepAlive(...sessions) {
  for (const session of sessions) {
    if (session) await poll(session);
  }
}

/**
 * Let a write become visible to the reads that follow it.
 *
 * Not a workaround for a product race: the assertions below are about policy — a
 * wave must not reach a busy session — and not about how fast two statements on
 * one database become consistent with each other. A short, bounded pause keeps
 * the assertion about the rule rather than about the round trip.
 */
const settle = () => sleep(1_200);

function signal(session, toId, type, connectionId, payload) {
  return post("/api/signal", {
    fromId: session.id,
    toId,
    type,
    connectionId,
    sessionToken: session.token,
    ...(payload === undefined ? {} : { payload }),
  });
}

// A wave is the one signal that carries no connection token, so it gets its own
// helper — `signal()` would file it under a connection and the server (rightly)
// refuses that.
function wave(session, toId, extra = {}) {
  return post("/api/signal", {
    fromId: session.id,
    toId,
    type: "wave",
    sessionToken: session.token,
    ...extra,
  });
}

// --- 1. Happy path -------------------------------------------------------
section("happy path: two anonymous users can still meet");
{
  const alice = await join();
  const bob = await join(48.85, 2.35);
  ok("join issues a session token", typeof alice.token === "string" && alice.token.length === 43);

  const polled = await poll(alice);
  ok("poll with the token succeeds", polled.status === 200);
  ok(
    "poll shows the other user's dot",
    Array.isArray(polled.body?.peers) &&
      polled.body.peers.some((p) => p.id === bob.id),
    JSON.stringify(polled.body?.peers),
  );
  ok("poll response is not cacheable", polled.headers.get("cache-control")?.includes("no-store"));
  ok("no x-powered-by on the API", !polled.headers.get("x-powered-by"));

  const connectionId = uuid();
  const requested = await signal(alice, bob.id, "request", connectionId);
  ok("request reserves the connection", requested.status === 200 && !requested.body.autoDeclined);

  const inbox = await poll(bob);
  ok(
    "target receives the request",
    inbox.body?.signals?.some((s) => s.type === "request" && s.connectionId === connectionId),
  );

  const accepted = await signal(bob, alice.id, "accept", connectionId);
  ok("accept succeeds", accepted.status === 200, JSON.stringify(accepted.body));

  const offer = await signal(
    alice,
    bob.id,
    "offer",
    connectionId,
    JSON.stringify({ type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n" }),
  );
  ok("offer relays into the target mailbox", offer.status === 200);

  const ice = await signal(
    alice,
    bob.id,
    "ice",
    connectionId,
    JSON.stringify({ candidate: "candidate:1 1 udp 2 10.0.0.1 5 typ host" }),
  );
  ok("ice relays", ice.status === 200);

  const ended = await signal(alice, bob.id, "end", connectionId);
  ok("end succeeds", ended.status === 200 && !ended.body.ignored);

  const afterEnd = await poll(alice);
  ok(
    "terminal message reaches both sides",
    afterEnd.body?.signals?.some((s) => s.type === "end" && s.connectionId === connectionId),
  );

  const left = await post("/api/leave", {
    id: alice.id,
    sessionToken: alice.token,
    incarnationId: alice.incarnationId,
  });
  ok("leave accepts the owning session", left.status === 200);
  const bobLeft = await post("/api/leave", {
    id: bob.id,
    sessionToken: bob.token,
    incarnationId: bob.incarnationId,
  });
  ok("leave accepts the second session", bobLeft.status === 200);
}

// --- 2. Session ownership ------------------------------------------------
section("IDOR: knowing a session id is not permission");
{
  const victim = await join(35.68, 139.69);
  const attacker = await join();

  // poll the victim's id with the attacker's own token
  const stolenPoll = await api(`/api/poll?id=${victim.id}`, {
    headers: { "x-pulse-session": attacker.token },
  });
  ok("poll refuses a foreign token", stolenPoll.status === 401, `got ${stolenPoll.status}`);

  const noToken = await api(`/api/poll?id=${victim.id}`);
  ok("poll refuses a missing token", noToken.status === 401);

  const garbage = await api(`/api/poll?id=${victim.id}`, {
    headers: { "x-pulse-session": "A".repeat(43) },
  });
  ok("poll refuses a guessed token", garbage.status === 401);

  // overwrite the victim's dot
  const hijackJoin = await post("/api/join", {
    id: victim.id,
    lat: 0,
    lng: 0,
    incarnationId: uuid(),
  });
  ok("join refuses to take over a live session", hijackJoin.status === 409, `got ${hijackJoin.status}`);

  const wrongToken = await post("/api/join", {
    id: victim.id,
    lat: 0,
    lng: 0,
    incarnationId: uuid(),
    sessionToken: attacker.token,
  });
  ok("join refuses a foreign token", wrongToken.status === 409, `got ${wrongToken.status}`);

  // the victim is untouched
  const victimSees = await poll(victim);
  ok(
    "victim's dot is not moved",
    victimSees.body?.peers?.some((p) => p.id === attacker.id) === true,
  );

  // delete / end the victim
  const bareLeave = await post("/api/leave", { id: victim.id });
  ok("bare leave is rejected", bareLeave.status === 401, `got ${bareLeave.status}`);

  const tokenLeave = await post("/api/leave", {
    id: victim.id,
    sessionToken: attacker.token,
    incarnationId: attacker.incarnationId,
  });
  ok("leave with a foreign token is rejected", tokenLeave.status === 401);

  const victimStill = await poll(victim);
  ok("victim still has a session", victimStill.status === 200);

  await post("/api/leave", {
    id: victim.id,
    sessionToken: victim.token,
    incarnationId: victim.incarnationId,
  });
  await post("/api/leave", {
    id: attacker.id,
    sessionToken: attacker.token,
    incarnationId: attacker.incarnationId,
  });
}

// --- 3. Signaling authorization -----------------------------------------
section("signaling: no injection into somebody else's session");
{
  const victim = await join(40.71, -74.0);
  const attacker = await join();
  const stranger = await join();
  const stolenConnectionId = uuid();

  const foreignOffer = await signal(attacker, victim.id, "offer", stolenConnectionId, "x");
  ok("offer with an unknown connection is refused", foreignOffer.status === 409, `got ${foreignOffer.status}`);

  // Naming a connection that does not exist must leave the victim alone. There
  // is nothing to refuse, so this is a no-op rather than an error.
  const unknownEnd = await signal(attacker, victim.id, "end", stolenConnectionId);
  ok("end with an unknown connection is a no-op", unknownEnd.status === 200);
  const victimUnharmed = await poll(victim);
  ok(
    "victim receives no message from that attempt",
    !victimUnharmed.body?.signals?.some((s) => s.connectionId === stolenConnectionId),
  );

  // A well-formed token that owns nothing, tried against a real id.
  const impersonate = await post("/api/signal", {
    fromId: victim.id,
    toId: stranger.id,
    type: "request",
    connectionId: uuid(),
    sessionToken: fakeToken(),
  });
  ok("cannot speak for another participant", impersonate.status === 401, `got ${impersonate.status}`);

  // A real connection between victim and stranger, then attacker tries to use it.
  const connectionId = uuid();
  await signal(victim, stranger.id, "request", connectionId);
  await signal(stranger, victim.id, "accept", connectionId);
  // Both sides heartbeat, so the reservation does not expire underneath the test.
  await poll(victim);
  await poll(stranger);

  const injectedOffer = await signal(attacker, victim.id, "offer", connectionId, "attacker-sdp");
  ok("non-participant cannot inject an offer", injectedOffer.status === 409, `got ${injectedOffer.status}`);

  const injectedEnd = await signal(attacker, stranger.id, "end", connectionId);
  ok("a non-participant's end is not treated as authoritative", injectedEnd.status === 200, `got ${injectedEnd.status}`);

  const victimInbox = await poll(victim);
  ok(
    "victim's mailbox has no attacker payload",
    !victimInbox.body?.signals?.some((s) => s.payload === "attacker-sdp"),
  );
  ok(
    "no end was written for the attacker's attempt",
    !victimInbox.body?.signals?.some((s) => s.type === "end" && s.fromId === attacker.id),
  );

  // The proof that the connection survived: only a participant can still get a
  // message into it.
  const stillLive = await signal(victim, stranger.id, "offer", connectionId, "v-sdp");
  ok("the connection is still live afterwards", stillLive.status === 200, `got ${stillLive.status}`);

  // A participant CAN end it.
  const realEnd = await signal(victim, stranger.id, "end", connectionId);
  ok("participant can end its own connection", realEnd.status === 200 && !realEnd.body.ignored);
  const strangerSees = await poll(stranger);
  ok(
    "peer is told the connection ended",
    strangerSees.body?.signals?.some((s) => s.type === "end" && s.connectionId === connectionId),
  );

  for (const s of [victim, attacker, stranger]) {
    await post("/api/leave", {
      id: s.id,
      sessionToken: s.token,
      incarnationId: s.incarnationId,
    });
  }
}

// --- 4. Auto-decline no longer impersonates ------------------------------
section("an unavailable target is not impersonated");
{
  const asker = await join(1, 1);
  const connectionId = uuid();
  // A session id nobody holds: the target is simply not there.
  const result = await signal(asker, uuid(), "request", connectionId);
  ok(
    "request for an absent target reports autoDeclined",
    result.status === 200 && result.body.autoDeclined === true,
    JSON.stringify(result.body),
  );
  const askerInbox = await poll(asker);
  ok(
    "requester is not sent a decline forged from anyone",
    !askerInbox.body?.signals?.some((s) => s.type === "decline"),
  );
  await post("/api/leave", { id: asker.id, sessionToken: asker.token, incarnationId: asker.incarnationId });
}

// --- 5. Waves -----------------------------------------------------------
section("waves: a one-way hello, and the abuse it must not allow");
{
  const waver = await join(51.5, -0.12); // London
  const far = await join(-33.87, 151.2); // Sydney
  // A real client heartbeats every 1.5s and a presence row lives 15s, so a test
  // that stops polling is not testing a live session — it is testing a ghost.
  await keepAlive(waver, far);

  const sent = await wave(waver, far.id);
  ok("wave is accepted", sent.status === 200 && sent.body.waved === true, JSON.stringify(sent.body));

  const inbox = await poll(far);
  const landed = inbox.body?.signals?.find((s) => s.type === "wave");
  ok("the wave reaches the target's mailbox", Boolean(landed));
  ok("a wave carries no payload", landed?.payload === null, `payload=${landed?.payload}`);
  ok("a wave belongs to no connection", landed?.connectionId === null, `connectionId=${landed?.connectionId}`);

  // The one abuse a connection request is exposed to is pinning a stranger:
  // reserving both rows marks their dot unavailable to everyone else. A wave
  // must not be able to do that, or it is a cheaper way to hold someone.
  const afterWave = await presenceOf(waver.id);
  const targetAfterWave = await presenceOf(far.id);
  ok(
    "a wave reserves nothing on either side",
    afterWave?.busy === false &&
      afterWave?.connectionId === null &&
      targetAfterWave?.busy === false &&
      targetAfterWave?.connectionId === null,
    `waver=${JSON.stringify(afterWave)} target=${JSON.stringify(targetAfterWave)}`,
  );

  // ...and it must not poison the reservation path either, which is the risk of
  // filing it under a null connection token.
  await keepAlive(waver, far);
  const realConnectionId = uuid();
  const reservable = await signal(waver, far.id, "request", realConnectionId);
  ok(
    "a wave does not block a later request",
    reservable.status === 200 && !reservable.body.autoDeclined,
    JSON.stringify(reservable.body),
  );
  await signal(waver, far.id, "end", realConnectionId);

  // A busy stranger is not addressable on the map, and a wave must not be a way
  // around that: there is deliberately no path that reaches a person who has
  // already said yes to somebody else.
  const busy = await join(48.85, 2.35);
  const connectionId = uuid();
  await keepAlive(waver);
  const reserve = await signal(busy, far.id, "request", connectionId);
  const accept = await signal(far, busy.id, "accept", connectionId);
  await keepAlive(busy, far, waver);
  await settle();
  const toBusy = await wave(waver, busy.id);
  ok(
    "a wave will not reach a busy session",
    toBusy.status === 200 && toBusy.body.waved === false,
    `reserve=${JSON.stringify(reserve.body)} accept=${accept.status} ${JSON.stringify(toBusy.body)}`,
  );
  const busyInbox = await poll(busy);
  ok(
    "the busy target's client is left alone",
    !busyInbox.body?.signals?.some((s) => s.type === "wave" && s.fromId === waver.id),
  );

  // A wave must not be fileable under a connection: that is how a message would
  // end up in somebody's terminal-marker or lease lookups.
  const withConnection = await wave(waver, far.id, { connectionId });
  ok("a wave carrying a connection token is 400", withConnection.status === 400, `got ${withConnection.status}`);

  const withPayload = await wave(waver, far.id, { payload: "hello" });
  ok("a wave carrying a payload is 400", withPayload.status === 400, `got ${withPayload.status}`);

  const toSelf = await wave(waver, waver.id);
  ok("a wave to yourself is 400", toSelf.status === 400, `got ${toSelf.status}`);

  // Every refusal above must have written nothing at all, not merely reported
  // failure. A 400 that still left a row behind would be a way to get a message
  // into a mailbox that no rate limit applies to.
  const wroteNothing = await waveRowsBetween(waver.id, busy.id);
  ok(
    "a refused wave writes no row",
    Array.isArray(wroteNothing) && wroteNothing.length === 0,
    JSON.stringify(wroteNothing),
  );

  // Forgery: a stranger cannot wave as somebody else, and the attempt must not
  // reach the person it was aimed at.
  await keepAlive(waver);
  const impersonate = await post("/api/signal", {
    fromId: far.id,
    toId: waver.id,
    type: "wave",
    sessionToken: fakeToken(),
  });
  ok("cannot send a wave as another participant", impersonate.status === 401, `got ${impersonate.status}`);
  const waverInbox = await poll(waver);
  ok(
    "the forged wave was never delivered",
    !waverInbox.body?.signals?.some((s) => s.type === "wave" && s.fromId === far.id),
  );

  // Ending the session takes the wave with it. A wave leaves the same trace a
  // request does and no longer: the sender leaving clears it immediately, and
  // the target leaving clears what was sent to them.
  const transient = await join(1, 1);
  await keepAlive(transient, waver);
  const outbound = await wave(transient, waver.id);
  ok("a wave from a short-lived session is accepted", outbound.status === 200 && outbound.body.waved === true, JSON.stringify(outbound.body));
  const beforeLeave = await poll(waver);
  ok(
    "the wave is queued before the sender leaves",
    beforeLeave.body?.signals?.some((s) => s.type === "wave" && s.fromId === transient.id),
    JSON.stringify(beforeLeave.body?.signals?.map((s) => s.type)),
  );
  await post("/api/leave", { id: transient.id, sessionToken: transient.token, incarnationId: transient.incarnationId });
  const afterLeave = await poll(waver);
  ok(
    "leaving takes the wave with it",
    !afterLeave.body?.signals?.some((s) => s.type === "wave" && s.fromId === transient.id),
  );

  for (const s of [waver, far, busy]) {
    await post("/api/leave", { id: s.id, sessionToken: s.token, incarnationId: s.incarnationId });
  }
}

// --- 6. Waves cannot be spammed ----------------------------------------
section("wave abuse is rate limited");
if (SKIP_ABUSE) {
  console.log("  SKIP  wave rate-limit assertions (--skip-abuse)");
} else {
  const spammer = await join(12, 12);

  // 1) hammering one stranger
  const victim = await join(13, 13);
  await keepAlive(spammer, victim);
  let perTargetBlocked = 0;
  for (let i = 0; i < 4; i += 1) {
    const result = await wave(spammer, victim.id);
    if (result.status === 429) perTargetBlocked += 1;
  }
  ok("a repeat wave to one stranger is rate limited", perTargetBlocked > 0, `${perTargetBlocked}/4 refused`);

  const victimInbox = await poll(victim);
  ok(
    "the rate limit bounds what landed in one mailbox",
    victimInbox.body?.signals?.filter((s) => s.type === "wave" && s.fromId === spammer.id).length <= 1,
  );

  // 2) spraying the map. Joined and waved in small groups on purpose.
  //
  //    Firing twenty-two joins and twenty-two waves at once does prove the limit,
  //    but it also hammers the reaper from forty-six concurrent requests, and the
  //    reaper's half-built-reservation repair (Phase 3) has a genuine race with
  //    `reserveConnection` that this load reliably exposes — see NOTES.md. A
  //    sequential client never sees it, and testing for a *limit* should not
  //    depend on provoking an unrelated race.
  const targets = [];
  for (let batch = 0; batch < 4; batch += 1) {
    targets.push(
      ...(await Promise.all(
        Array.from({ length: 6 }, (_, i) => join(20 + (batch * 6 + i) * 0.01, 30 + i * 0.01)),
      )),
    );
    await keepAlive(spammer);
  }
  const spray = [];
  for (let i = 0; i < targets.length; i += 4) {
    const group = targets.slice(i, i + 4);
    // Each target is heartbeated immediately before it is waved at. A recipient
    // that had stopped polling is no longer on the map, and a wave at somebody
    // who is not there is correctly refused — which would make this a test of
    // staleness instead of a test of the limit.
    await keepAlive(spammer, ...group);
    spray.push(...(await Promise.all(group.map((t) => wave(spammer, t.id)))));
  }
  const tally = {};
  for (const result of spray) {
    const key = `${result.status}:${JSON.stringify(result.body)}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  ok(
    "spraying waves at the whole map is rate limited",
    spray.filter((r) => r.status === 429).length > 0,
    JSON.stringify(tally),
  );
  const accepted = spray.filter((r) => r.status === 200 && r.body?.waved).length;
  // The other half of the assertion, and the one that matters: a limit that only
  // ever says no is not a limit, it is an outage.
  ok("but an honest handful still gets through", accepted >= 10, `${accepted} accepted, ${JSON.stringify(tally)}`);

  for (const s of [spammer, victim, ...targets]) {
    await post("/api/leave", { id: s.id, sessionToken: s.token, incarnationId: s.incarnationId });
  }
}

// --- 7. Input validation -------------------------------------------------
section("input validation");
{
  const session = await join();

  const badMethod = await api("/api/join", { method: "DELETE" });
  ok("unimplemented method is 405", badMethod.status === 405, `got ${badMethod.status}`);

  const badBody = await api("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  ok("malformed JSON is 400", badBody.status === 400, `got ${badBody.status}`);

  const arrayBody = await post("/api/join", ["a", "b"]);
  ok("array body is 400", arrayBody.status === 400);

  const badCoords = await post("/api/join", {
    id: uuid(),
    lat: 999,
    lng: 0,
    incarnationId: uuid(),
  });
  ok("out-of-range coordinates are 400", badCoords.status === 400);

  const nanCoords = await post("/api/join", {
    id: uuid(),
    lat: "51.5",
    lng: null,
    incarnationId: uuid(),
  });
  ok("non-numeric coordinates are 400", nanCoords.status === 400);

  const badId = await post("/api/join", { id: "x", lat: 1, lng: 1, incarnationId: uuid() });
  ok("malformed id is 400", badId.status === 400);

  const noIncarnation = await post("/api/join", { id: uuid(), lat: 1, lng: 1 });
  ok("missing incarnation id is 400", noIncarnation.status === 400);

  const wrongType = await api("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "id=1",
  });
  ok("form content type is 415", wrongType.status === 415, `got ${wrongType.status}`);

  const huge = await api("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: uuid(), lat: 1, lng: 1, incarnationId: uuid(), pad: "A".repeat(200_000) }),
  });
  ok("oversized join body is 413", huge.status === 413, `got ${huge.status}`);

  const longUrl = await api(`/api/poll?id=${session.id}&ack=${Array(400).fill(uuid()).join(",")}`, {
    headers: { "x-pulse-session": session.token },
  });
  ok("over-long poll url is rejected", longUrl.status === 414 || longUrl.status === 400, `got ${longUrl.status}`);

  const stranger = await join(2, 2);
  const connectionId = uuid();
  await signal(session, stranger.id, "request", connectionId);
  await signal(stranger, session.id, "accept", connectionId);

  const badType = await signal(session, stranger.id, "nope", connectionId);
  ok("unknown signal type is 400", badType.status === 400, `got ${badType.status}`);

  const selfSignal = await signal(session, session.id, "offer", connectionId, "x");
  ok("self-addressed signal is 400", selfSignal.status === 400);

  const payloadOnRequest = await signal(session, stranger.id, "request", uuid(), "payload");
  ok("payload on a request is 400", payloadOnRequest.status === 400, `got ${payloadOnRequest.status}`);

  const giantSdp = await signal(session, stranger.id, "offer", connectionId, "A".repeat(40_000));
  ok("oversized sdp is 400", giantSdp.status === 400, `got ${giantSdp.status}`);

  const giantIce = await signal(session, stranger.id, "ice", connectionId, "A".repeat(9_000));
  ok("oversized ice is 400", giantIce.status === 400, `got ${giantIce.status}`);

  const nonStringPayload = await post("/api/signal", {
    fromId: session.id,
    toId: stranger.id,
    type: "offer",
    connectionId,
    sessionToken: session.token,
    payload: { sdp: "v=0" },
  });
  ok("object payload is 400", nonStringPayload.status === 400);

  await signal(session, stranger.id, "end", connectionId);
  for (const s of [session, stranger]) {
    await post("/api/leave", { id: s.id, sessionToken: s.token, incarnationId: s.incarnationId });
  }
}

// --- 8. Cross-origin -----------------------------------------------------
section("cross-origin writes");
{
  const session = await join(3, 3);
  const forged = await post(
    "/api/join",
    { id: session.id, lat: 0, lng: 0, incarnationId: uuid() },
    { Origin: "https://evil.example" },
  );
  ok("cross-origin join is 403", forged.status === 403, `got ${forged.status}`);

  const sameOrigin = await post(
    "/api/join",
    { id: session.id, lat: 3, lng: 3, incarnationId: session.incarnationId, sessionToken: session.token },
    { Origin: BASE },
  );
  ok("same-origin join is allowed", sameOrigin.status === 200, `got ${sameOrigin.status}`);

  const noOrigin = await post("/api/leave", {
    id: session.id,
    sessionToken: session.token,
    incarnationId: session.incarnationId,
  });
  ok("no-origin leave (beacon) is allowed", noOrigin.status === 200);
}

// --- 9. A connection cannot be held forever ------------------------------
section("connection lifetime is capped");
{
  const holder = await join(20, 20);
  const other = await join(21, 21);
  const connectionId = uuid();
  await signal(holder, other.id, "request", connectionId);
  await signal(other, holder.id, "accept", connectionId);

  await poll(holder, connectionId);
  ok("connected client may renew its lease", true);

  // Age the connection past MAX_CONNECTION_MS, the way a long call would.
  await ageConnection(connectionId);

  const after = await poll(holder, connectionId);
  ok("poll still works on an over-long connection", after.status === 200);
  const lease = await leaseOf(holder.id);
  ok("an over-long connection stops renewing its lease", lease <= Date.now() + 5_000, `lease=${lease}`);

  // Expire it, as the last renewal would have, and let the reaper notice. The
  // reaper is throttled per instance, so give it the window it needs.
  await expireLease(connectionId);
  await poll(other);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const holderSees = await poll(holder);
  ok(
    "the holder is told the connection is over",
    holderSees.body?.signals?.some((s) => s.type === "end") ||
      holderSees.body?.endedConnectionIds?.includes(connectionId),
    JSON.stringify(holderSees.body?.endedConnectionIds),
  );

  for (const s of [holder, other]) {
    await post("/api/leave", { id: s.id, sessionToken: s.token, incarnationId: s.incarnationId });
  }
}

// --- 10. Abusive client ---------------------------------------------------
section("resource abuse");
if (SKIP_ABUSE) {
  console.log("  SKIP  rate-limit assertions (--skip-abuse)");
} else {
  const flooder = await join(4, 4);
  const target = await join(5, 5);

  // 1) connection-request spam
  let cooldownBlocked = 0;
  for (let i = 0; i < 12; i += 1) {
    const result = await signal(flooder, target.id, "request", uuid());
    if (result.status === 429) cooldownBlocked += 1;
  }
  ok("request cooldown rate-limits a flood", cooldownBlocked > 0, `${cooldownBlocked}/12 refused`);

  // 2) signalling spam into one mailbox
  const spammer = await join(6, 6);
  const victim = await join(7, 7);
  const connectionId = uuid();
  const first = await signal(spammer, victim.id, "request", connectionId);
  ok("mailbox flood has a live connection to flood", first.status === 200 && !first.body.autoDeclined, JSON.stringify(first.body));
  let inboxFloodBlocked = 0;
  // One burst, so the whole flood lands inside a single rate-limit window.
  const flood = await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      signal(spammer, victim.id, "ice", connectionId, JSON.stringify({ candidate: `c${i}` })),
    ),
  );
  inboxFloodBlocked = flood.filter((r) => r.status === 429).length;
  ok("per-connection signalling limit bites", inboxFloodBlocked > 0, `${inboxFloodBlocked}/60 refused`);

  const inbox = await poll(victim);
  ok(
    "poll returns a bounded inbox",
    Array.isArray(inbox.body?.signals) && inbox.body.signals.length <= 50,
    `got ${inbox.body?.signals?.length}`,
  );
  for (const s of [spammer, victim]) {
    await post("/api/leave", { id: s.id, sessionToken: s.token, incarnationId: s.incarnationId });
  }

  // 3) unauthenticated poll flood, using well-formed but wrong tokens so the
  //    request actually reaches the limiter.
  const id = uuid();
  let refused = 0;
  let unauthStatus = null;
  for (let burst = 0; burst < 3; burst += 1) {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => api(`/api/poll?id=${id}`, {
        headers: { "x-pulse-session": fakeToken() },
      })),
    );
    unauthStatus ??= results[0].status;
    refused += results.filter((r) => r.status === 429).length;
  }
  ok("poll with a wrong token is 401", unauthStatus === 401, `got ${unauthStatus}`);
  ok("unauthenticated poll flood is rate limited", refused > 0, `${refused}/60 refused`);

  // 4) join flood, from one address
  let joinRefused = 0;
  for (let burst = 0; burst < 3; burst += 1) {
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        post("/api/join", { id: uuid(), lat: 1, lng: 1, incarnationId: uuid() }, { "x-forwarded-for": ABUSE_IP }),
      ),
    );
    joinRefused += results.filter((r) => r.status === 429).length;
  }
  ok("join flood is rate limited", joinRefused > 0, `${joinRefused}/90 refused`);

  await post("/api/leave", { id: flooder.id, sessionToken: flooder.token, incarnationId: flooder.incarnationId });
  await post("/api/leave", { id: target.id, sessionToken: target.token, incarnationId: target.incarnationId });
}

// --- 11. Error bodies carry nothing ---------------------------------------
section("error responses leak nothing");
{
  const responses = [
    await api(`/api/poll?id=${uuid()}`),
    await post("/api/join", { id: "nope" }),
    await post("/api/signal", { fromId: uuid(), toId: uuid(), type: "offer", connectionId: uuid() }),
  ];
  for (const response of responses) {
    const text = JSON.stringify(response.body);
    ok(
      `error body is a short code (${response.status})`,
      Object.keys(response.body ?? {}).length === 1 &&
        typeof response.body.error === "string" &&
        text.length < 80,
      text.slice(0, 120),
    );
  }
  const bad = responses[0];
  ok("unknown session is 401 or 400, never 500", bad.status === 401 || bad.status === 400, `got ${bad.status}`);
}

// --- 12. Response headers -------------------------------------------------
section("response hardening");
{
  const page = await fetch(BASE, { redirect: "manual" });
  const csp = page.headers.get("content-security-policy") ?? "";
  ok("page sends a content-security-policy", csp.length > 0);
  ok("CSP forbids framing", csp.includes("frame-ancestors 'none'"));
  ok("CSP forbids plugins and base-uri tricks", csp.includes("object-src 'none'") && csp.includes("base-uri 'none'"));
  ok("CSP restricts form posts to us", csp.includes("form-action 'self'"));
  ok(
    "CSP allows the origins Mapbox GL needs and nothing else",
    csp.includes("https://api.mapbox.com") && csp.includes("blob:") && !csp.includes("*;"),
    csp.slice(0, 160),
  );
  ok("nosniff is set", page.headers.get("x-content-type-options") === "nosniff");
  ok("frames are denied", page.headers.get("x-frame-options") === "DENY");
  ok("no referrer leaves the app", page.headers.get("referrer-policy") === "no-referrer");
  const perms = page.headers.get("permissions-policy") ?? "";
  ok(
    "camera, mic and location are same-origin only",
    perms.includes("camera=(self)") && perms.includes("microphone=(self)") && perms.includes("geolocation=(self)"),
    perms,
  );
  ok("framework is not advertised", !page.headers.get("x-powered-by"));

  const apiResponse = await api(`/api/poll?id=${uuid()}`);
  ok("api responses are not cacheable", apiResponse.headers.get("cache-control")?.includes("no-store"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed: ${failures.join(", ")}`);
process.exit(fail === 0 ? 0 : 1);
