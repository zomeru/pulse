// Phase 3 API probe. Drives the coordination API over HTTP exactly like a
// malicious client would, and prints a pass/fail line per check.
//
//   node scripts/api-probe.mjs [baseUrl]

import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const BASE = args.find((arg) => !arg.startsWith("--")) ?? "http://localhost:3000";
// The abuse section needs the rate limiter; `--skip-abuse` runs the rest.
const SKIP_ABUSE = args.includes("--skip-abuse");

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

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
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
  if (result.status !== 200) throw new Error(`join failed: ${result.status}`);
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

  // A real connection between victim and stranger, then attacker tries to use it.
  const connectionId = uuid();
  await signal(victim, stranger.id, "request", connectionId);
  await signal(stranger, victim.id, "accept", connectionId);

  const injectedOffer = await signal(attacker, victim.id, "offer", connectionId, "attacker-sdp");
  ok("non-participant cannot inject an offer", injectedOffer.status === 409, `got ${injectedOffer.status}`);

  const injectedEnd = await signal(attacker, stranger.id, "end", connectionId);
  ok("non-participant cannot end a live connection", injectedEnd.status === 200 && injectedEnd.body.ignored);

  const victimInbox = await poll(victim);
  ok(
    "victim's mailbox has no attacker payload",
    !victimInbox.body?.signals?.some((s) => s.payload === "attacker-sdp"),
  );

  const victimStillReserved = await poll(victim);
  ok("victim is still connected", victimStillReserved.status === 200);
  const reserved = victimStillReserved.body?.signals?.filter((s) => s.type === "end");
  ok("no forged end for the victim", !reserved?.some((s) => s.connectionId === connectionId && s.fromId === attacker.id));

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

// --- 5. Input validation -------------------------------------------------
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

// --- 6. Cross-origin -----------------------------------------------------
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

// --- 7. A connection cannot be held forever ------------------------------
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

// --- 8. Abusive client ---------------------------------------------------
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
  for (let burst = 0; burst < 4; burst += 1) {
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        signal(spammer, victim.id, "ice", connectionId, JSON.stringify({ candidate: `c${burst}-${i}` })),
      ),
    );
    inboxFloodBlocked += results.filter((r) => r.status === 429).length;
  }
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

  // 4) join flood
  let joinRefused = 0;
  for (let burst = 0; burst < 3; burst += 1) {
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        post("/api/join", { id: uuid(), lat: 1, lng: 1, incarnationId: uuid() }),
      ),
    );
    joinRefused += results.filter((r) => r.status === 429).length;
  }
  ok("join flood is rate limited", joinRefused > 0, `${joinRefused}/90 refused`);

  await post("/api/leave", { id: flooder.id, sessionToken: flooder.token, incarnationId: flooder.incarnationId });
  await post("/api/leave", { id: target.id, sessionToken: target.token, incarnationId: target.incarnationId });
}

// --- 9. Error bodies carry nothing ---------------------------------------
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

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed: ${failures.join(", ")}`);
process.exit(fail === 0 ? 0 : 1);
