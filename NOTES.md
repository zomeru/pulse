# Pulse — Notes

**Repo:** https://github.com/zomeru/pulse · **Live:** https://pulse-zom.vercel.app

## Phase 1 — Make it run

The starting project had several issues affecting database setup, chat, WebRTC reconnects, and presence cleanup.

* Fixed the Neon database connection and separated application and database-tooling connection strings.
* Fixed chat messages being silently dropped by aligning the data-channel message format and reporting failed sends.
* Fixed WebRTC reconnect races where an old connection could interfere with a newer one.
* Fixed stale presence and connection cleanup using session-scoped handlers and expiring connection leases.
* Prevented late requests and callbacks from old sessions from affecting newer sessions.

## Phase 2 — Make it good

I focused on making the globe feel like the main product rather than just a map with controls around it.

* Redesigned the visual style around a dark, night-time earth with distinct user dots.
* Added clearer dot states, including an unavailable state for users already in a conversation.
* Improved zoom behavior, world centering, resizing, and the recenter control.
* Simplified the connection flow into a clear progress/status bar.
* Improved chat and video UI, including message grouping, timestamps, typing indicators, growing text input, IME handling, auto-scroll behavior, and video framing.
* Improved mobile behavior so the chat works with the keyboard while keeping the map accessible.
* Added accessible labels, reduced-motion support, and preserved map gestures.
* Kept the implementation lightweight by using CSS and existing project capabilities instead of adding animation or UI libraries.

Testing also uncovered issues in map sizing, map style loading, and the custom recenter control. These were fixed before moving on.

One remaining accessibility improvement is expanding the clickable area around the map dots without increasing their visual size.

## Phase 3 — Make it secure

The main security issue was that session IDs were exposed through the presence API but were also being treated as proof of ownership.

I ranked the findings by impact and addressed the major issues:

* Added server-issued session capability tokens so knowing a session ID is no longer enough to control it.
* Added authorization checks for polling, joining, leaving, and WebRTC signalling.
* Prevented clients from impersonating other users through server-generated messages.
* Added request validation and limits for request bodies, URLs, inboxes, mailboxes, and poll responses.
* Added database-backed rate limiting for serverless-safe abuse protection.
* Added connection expiry so connections cannot be held indefinitely.
* Added security headers, production-safe error responses, and cross-origin protection for state-changing endpoints.
* Kept the existing anonymous model. No accounts or persistent identity were introduced.

I tested the API against cross-session access, signalling, validation, rate limiting, resource abuse, error handling, and security headers. Testing also uncovered regressions in authorization and rate limiting, which were fixed.

Known limitation: connection reservation is still vulnerable to a race during concurrent cleanup because the operation spans multiple database writes. This is documented as the next backend improvement.

Browser automation had limitations around real WebRTC and camera access, so those parts were tested separately where necessary.

## Phase 4 — Make it better

I added **Waves**, a lightweight interaction between strangers that sits between simply seeing someone and starting a conversation.

A user can arm the wave tool and send a wave to another available dot. The receiver sees a visual wave traveling across the map and can wave back. A mutual wave creates a temporary visual connection and offers the option to connect.

The feature was designed around the existing anonymous model:

* Waves contain no message, profile, or persistent information.
* They do not reserve a connection or make a user unavailable.
* They only work while both users are available.
* They use the existing authenticated mailbox and rate-limiting mechanisms.
* Wave state is temporary and disappears when the session ends.
* Limits prevent repeated waves from becoming a way to spam another user's presence.

Testing uncovered and fixed issues with wave delivery and incoming-wave UI updates.

The main remaining product weakness is discoverability. The wave interaction is intentionally subtle, so I would improve how users discover it without adding a tutorial or changing the anonymous nature of the app.

## Additional improvements

These were not required by the assessment but were done to leave the project easier to maintain:

* Migrated from npm to pnpm and pinned the package manager version.
* Replaced ESLint with Oxlint and added Oxfmt.
* Added a single `pnpm check` command for linting, formatting, typechecking, and the API probe.
* Kept runtime dependencies unchanged.

## Trade-offs and known limitations

* **Connection requests:** Without accounts, a request cannot be strongly attributed to a real-world identity. The target client validates whether it initiated the request.
* **Map accessibility:** The visual dot size is intentionally kept compact, but the clickable area could be improved further.
