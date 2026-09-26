// The whole engineering validation flow, in one command.
//
//   pnpm check
//   pnpm check -- --skip-abuse      # extra args are forwarded to the api-probe
//
// Four steps, in order, stopping at the first failure:
//
//   1. lint            oxlint
//   2. format:check    oxfmt --check
//   3. typecheck       tsc --noEmit
//   4. api-probe       scripts/api-probe.mjs against a running server
//
// The first three are static and need nothing running. The fourth does not: the
// probe is an HTTP client, so it needs a server to talk to. Rather than have
// this script start and stop `next dev` — a dev server that outlives a Ctrl-C,
// a port that has not finished releasing, and a "works locally, breaks in CI"
// split — it checks that something is already listening and says so plainly if
// not. Run `pnpm dev` in another terminal.

import { spawnSync } from "node:child_process";
import net from "node:net";

// pnpm is a .cmd on Windows, and since Node 20.19 spawning one without a shell
// is refused, so the shell is only used there. The three static steps take no
// user input; the probe's forwarded args are the developer's own, and the same
// exposure as typing them on the command line.
const IS_WINDOWS = process.platform === "win32";
const PNPM = IS_WINDOWS ? "pnpm.cmd" : "pnpm";

/** The steps, in the order they run. The probe is handled separately. */
const STATIC_STEPS = [
  { name: "lint", script: "lint" },
  { name: "format:check", script: "format:check" },
  { name: "typecheck", script: "typecheck" },
];

/** Resolved the same way the probe resolves it, so the two cannot disagree. */
function probeBaseUrl(args) {
  return args.find((arg) => !arg.startsWith("--")) ?? "http://localhost:3000";
}

/**
 * Is anything listening on the probe's target?
 *
 * A TCP connect, not an HTTP GET on purpose: a dev server binds its port
 * before it has compiled a single route, so a cold `next dev` can take seconds
 * to answer a request while the socket is already accepting connections. This
 * asks the only question that is a real precondition — is the server up — and
 * answers it immediately either way.
 */
function isListening(url, timeoutMs = 2_000) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect({
      host: hostname,
      // A missing port in the URL means the scheme's default.
      port: port ? Number(port) : url.startsWith("https") ? 443 : 80,
    });
    const done = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function run(label, args) {
  console.log(`\n== check: ${label}`);
  const result = spawnSync(PNPM, ["run", ...args], {
    stdio: "inherit",
    shell: IS_WINDOWS,
  });
  // A signal or a missing binary is not a zero exit code, so check it explicitly
  // rather than letting `status !== 0` report success for `null`.
  if (result.error) {
    console.error(`check: ${label} could not start: ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

function fail(step) {
  console.error(`\ncheck failed: ${step}`);
  process.exit(1);
}

const forwarded = process.argv.slice(2);
const baseUrl = probeBaseUrl(forwarded);

for (const step of STATIC_STEPS) {
  if (!run(step.name, [step.script])) fail(step.name);
}

if (!(await isListening(baseUrl))) {
  console.error(
    [
      "",
      "check failed: api-probe",
      "",
      `  Nothing is listening on ${baseUrl}. The probe is an HTTP client, so it`,
      "  needs a running server. Start one in another terminal:",
      "",
      "      pnpm dev",
      "",
      "  The three steps before this one do not need a server and can be run on",
      "  their own: pnpm lint, pnpm format:check, pnpm typecheck.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (!run("api-probe", ["api-probe", ...forwarded])) fail("api-probe");

console.log("\ncheck passed");
