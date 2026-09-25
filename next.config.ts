import type { NextConfig } from "next";

// A Content Security Policy that is actually tested against this app, not
// guessed at. The awkward parts are all Mapbox GL JS: it runs its worker from a
// blob URL, loads a wasm module, and talks to api.mapbox.com for styles, tiles,
// glyphs and fonts. WebRTC is unaffected by CSP (getUserMedia is governed by
// Permissions-Policy instead), and chat and video never touch the server.
//
// `'unsafe-inline'` for scripts is a deliberate, temporary trade-off: Next's App
// Router inlines its flight data in a <script> tag, and removing it needs a
// per-request nonce, which means forcing every page to render dynamically. The
// honest next step is `proxy.ts` with a nonce (documented in the Next docs);
// until then, `'unsafe-inline'` is what buys a policy that is enforced rather
// than aspirational. Nothing in this app renders user input as markup, and
// React escapes by default, so the exposure is limited.
const isDev = process.env.NODE_ENV === "development";

const contentSecurityPolicy = [
  "default-src 'self'",
  // Pulse has no user pages, no framing use case and no plugins.
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${
    isDev ? " 'unsafe-eval'" : ""
  }`,
  // Markers, the map canvas and the app's own inline styles all need this.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.mapbox.com",
  "font-src 'self' data: https://api.mapbox.com",
  // The map's styles, tiles, glyphs and telemetry, plus the map worker's blob.
  `connect-src 'self' blob: https://api.mapbox.com https://*.mapbox.com https://events.mapbox.com`,
  "worker-src 'self' blob:",
  "media-src 'self' blob: mediastream:",
].join("; ");

const nextConfig: NextConfig = {
  // Allow the ngrok tunnel host to access dev resources (HMR, etc.).
  allowedDevOrigins: ["kind-intensely-herring.ngrok-free.app"],
  // Free information: every response otherwise names the framework.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          // Nothing here is user-uploaded, but a sniffed response on an API
          // route is still a response nobody asked to be interpreted.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // This is an app about not being findable. Mapbox tiles are a
          // cross-origin request, and the default would still hand them the
          // page's origin.
          { key: "Referrer-Policy", value: "no-referrer" },
          // Clickjacking: there is no reason to embed this full-screen map.
          { key: "X-Frame-Options", value: "DENY" },
          // The camera, the microphone and the location are the product, and
          // they are only ever needed by this origin. Embedded in someone
          // else's page they would be that page's to ask for.
          {
            key: "Permissions-Policy",
            value:
              "camera=(self), microphone=(self), geolocation=(self), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
