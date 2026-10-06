# Xytrion Markets

This repository preserves the supplied static frontend design and adds a server-side Node.js/MongoDB application for authentication, account data, financial records, market data, live chat, and Telegram administration.

## Requirements

- Node.js 20+
- MongoDB replica set (transactions are required for atomic balance and ledger updates)
- Optional Telegram bot configuration; a separate SMTP account with a verified sender is needed for customer email. The public Kraken and CoinGecko market endpoints require no API key for local testing.

## Setup

```bash
cp .env.example .env
# Fill SESSION_SECRET and MONGODB_URI; configure SMTP to actually send customer emails.
npm install
npm run doctor
npm start
```

Open `http://localhost:3000`. The server binds to `0.0.0.0` and serves the retained HTML/CSS/JS frontend from the project root.

> Do not open `register.html` directly and do not serve the project with VS Code Live Server, `python -m http.server`, GitHub Pages, or another static-only host. Registration requires the Node API at `/api/auth/register`, so the frontend and API must be served by `npm start` from the same origin.

For the included MongoDB replica-set container setup:

```bash
SESSION_SECRET='replace-with-a-random-value-of-at-least-32-characters' docker compose up --build
```

`docker-compose.yml` refuses to start without an externally supplied session secret.

## Required environment variables

| Variable         | Purpose                                                   |
| ---------------- | --------------------------------------------------------- |
| `SESSION_SECRET` | At least 32 characters; signs server-side session cookies |
| `MONGODB_URI`    | MongoDB replica-set connection string                     |

Telegram credentials are optional. If `TELEGRAM_POLLING_ENABLED=true`, configure `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, and preferably `TELEGRAM_ADMIN_USER_IDS`. **Telegram tokens do not send email to users.** Browser code never receives Telegram or SMTP credentials.

## Architecture and security

- Passwords are hashed with bcrypt (cost 12) and never returned to the client.
- Authentication uses an HTTP-only, SameSite server session. Protected HTML routes are denied before static files are served.
- Password policy: 8+ characters, uppercase, lowercase, and a special character.
- Registration, login, profile updates, password changes, and account deletion are server-backed.
- Account deletion disables the account, anonymizes identity fields, deletes chat messages, bell notifications and queued customer emails, redacts withdrawal destinations, revokes the session, and retains immutable financial ledgers for audit integrity.
- Balances use integer cents and MongoDB transactions. Every adjustment creates a unique, idempotent ledger entry.
- Deposits, withdrawals, investments, and administrative funding are persistent MongoDB records.
- Deposit proof and KYC images are validated in memory and forwarded only by the server; no credential is exposed in browser JavaScript.
- Uploads are limited by size and accepted image signatures.
- State-changing cross-origin requests are rejected, auth routes are rate-limited, and Helmet security headers are enabled.
- BTC/ETH navbar quotes and cryptocurrency rows on Live Markets use **the same** `/api/market/prices` USD response. The server checks Kraken USD pairs (30-second cache) and keyless CoinGecko market data (two-minute cache); Kraken takes priority when both provide the same asset. Provider failures use only recently verified quotes, otherwise the UI says Unavailable rather than displaying the original hardcoded prices. These public feeds have rate limits and are best-effort; for a production-scale deployment, arrange a market-data provider with suitable terms and availability.

## Live market prices

Open `http://localhost:3000/api/market/prices`: a healthy response includes `"available":true`, `quotes.BTC.price`, `quotes.ETH.price`, and quotes for other supported listed assets. The navbar and Live Markets table display those **same BTC/ETH values**, refreshing approximately every 30 seconds. Additional assets appear when their identity and USD price can be verified; unsupported or temporarily unquoted assets visibly show **Unavailable**, never an old fixed price. Kraken changes use the current UTC day's opening price; CoinGecko changes cover 24 hours, so the mixed-provider column is labeled **Price Change**.

If the endpoint reports `"available":false`, run `npm run doctor` and check outbound HTTPS access to `api.kraken.com` and `api.coingecko.com`. If your older `.env` includes `MARKET_API_BASE`, it must refer to Kraken's public REST base `https://api.kraken.com/0/public`, **not** a CoinGecko URL. The optional `COINGECKO_API_BASE` must refer to `https://api.coingecko.com/api/v3`. Neither setting requires a token. Wait up to a few seconds for the first request and hard-refresh the page after updating the app.

## Deposit destinations

The UI retrieves wallet configuration from `/api/config/deposit-wallets`:

| Asset | Network | Default address                              |
| ----- | ------- | -------------------------------------------- |
| USDT  | TRC20   | `TQiZD8zedxCLZYZXXtx4v6M7biQuzypGFp`         |
| BTC   | Bitcoin | `bc1qvyumeqtwp0xl4mg8lq0z0wsvmgp76f80ensuxw` |

Override either address using the corresponding variables in `.env.example`.

The deposit form identifies **USDT (TRC20)** and **BTC (Bitcoin)** before proceeding. The payment page displays the selected wallet network immediately beside the address, then confirms the network and destination through the authenticated wallet API.

## Updating an older local copy

Extract the latest ZIP into a new folder, copy only your private `.env` file from the old folder into the new project's root, run `npm ci`, `npm run doctor`, and `npm start` there, then hard-refresh `http://localhost:3000`. Keep the old copy until the new one is working. Never include `.env` in a shared ZIP or paste its values into support messages.

Protected dashboard pages, including Account Statement, now hydrate user details from the validated server session instead of redirecting based on missing localStorage. Opening Account Statement no longer signs out an authenticated user.

Sidebar destinations on the dashboard, KYC, verification, and nested pages use correct routes. Read-only `/api/auth/me` checks no longer count toward the login rate limit. A temporary API connection error shows a warning instead of deleting a valid browser session; only HTTP 401 means the server session has expired. The homepage YouTube embed has been removed.

## AI Trading Bots

The five plans, category filters, investment modal, amount/balance validation, active-plan cards, progress countdowns, daily earnings breakdown, history, and maturity payout follow the behavior of the originally supplied bot page. The plan cards load when the plans API responds, rather than disappearing after the initial page render. Investments, balance deductions, simulated daily accrual, and one-time payout are now stored transactionally in MongoDB instead of mutable browser storage. The displayed daily rates are **simulated**; this application does **not** connect to an exchange, execute real trades, or guarantee returns.

## Live chat

- The shared launcher is loaded exactly once on all 34 HTML pages using absolute `/dashboard/chat-widget.*` asset paths.
- Signed-out visitors can see and open the widget and are given a sign-in link.
- Signed-in users can send messages and receive server-backed replies from every public, dashboard, account, payment, and KYC page.
- The launcher is injected before the authentication check, so an unavailable API no longer makes it disappear; instead, the widget displays a connection diagnostic.
- The KYC and verification pages load the shared API client and session hydrator before the auth guard, preventing false redirects and failed chat initialization.

## Account notifications and customer email

- The bell on every protected page displays **only persisted activity for the signed-in account**: registration, successful login, deposit proof submitted, withdrawal requested, and AI bot investment started. Authorized admin deposit/withdrawal status changes also appear. There are no sample or historical fabricated entries.
- An authenticated server-sent event stream updates the unread badge and list promptly across open tabs; a short database check handles multiple server instances, and the browser falls back to polling if the stream is unavailable. Opening a notification marks it read and opens the matching page; **Mark all read** clears the unread count. A user cannot read another account's notifications.
- Registration, deposit submission and withdrawal request **queue emails to the user's registered address**. Deposit/withdrawal emails say **Processing**, not credited or completed. Login and investment create bell notifications only. The emails contain no password, proof image, or full withdrawal address.
- Registration, deposit and withdrawal records commit together with their bell notification and email outbox entry; an investment debit commits together with its bell entry. If those required database writes fail, the business action rolls back rather than reporting a misleading success. Login likewise fails and revokes its new session if its event cannot be recorded. Administrator deposit/withdrawal status updates and their bell events commit together.
- **Email is not sent by MongoDB or Telegram.** To enable delivery, set the following in your private `.env` using an SMTP account and a **verified sender** supplied by your mail provider:

  ```dotenv
  SMTP_HOST=smtp.your-provider.example
  SMTP_PORT=587
  SMTP_SECURE=false
  SMTP_USER=your-smtp-username
  SMTP_PASS=your-smtp-password-or-app-password
  SMTP_FROM="Xytrion Markets <notifications@your-verified-domain.example>"
  ```

  Port 587 requires STARTTLS. For port 465 set `SMTP_PORT=465` and `SMTP_SECURE=true`. Do **not** put these credentials in frontend JavaScript or a shared ZIP. Docker Compose passes these environment variables through without baking them into its image.

- Restart `npm start`, then run `npm run doctor` to **verify SMTP connection/authentication** without sending a test email. Without complete SMTP settings, account actions still work and emails stay queued in MongoDB; after valid settings are supplied and the server restarts, the outbox attempts pending messages. Failed sends retry with backoff (up to eight attempts), rather than showing a misleading email success message. Confirm actual delivery with your provider's activity logs and a mailbox you control; SMTP acceptance does not guarantee inbox placement.

## Telegram administration

Deposit notifications include **PENDING**, **RECEIVED**, **ADD FUND**, and **RESET** buttons. Withdrawal and KYC notifications retain their status actions.

- Only the configured admin chat and numeric admin user IDs can execute actions.
- `/addfund` starts a guided flow: user email/username → amount → explicit confirmation.
- Funding writes an atomic balance change, ledger entry, and administrative action record.
- **RESET** only reverses one unambiguous, unreversed funding action and refuses to guess if multiple actions or later balance activity exist.
- `/reset ACTION_SESSION` reverses a specific action when safe.
- Every button/action reports a session ID, action label, and final status after processing. Failures include a short error reason.
- Telegram `update_id` offsets and chat replies are persisted in MongoDB, so browser polling is not used.

## Validation

```bash
npm run lint
npm test
npm run check
npm run build
```

## Registration troubleshooting

Before registering, open `http://localhost:3000/api/health`. A working application returns JSON similar to:

```json
{ "ok": true, "api": "online", "database": "connected" }
```

If the browser displays HTML, a hosting-provider page, `Cannot GET /api/health`, or a 404, the request is not reaching this Node application. Configure the hosting service to run `npm start` rather than publishing the repository as static files. Run `npm run doctor` on the server to validate the environment file and MongoDB connection without printing secrets.

An **HTTP 405** from registration specifically means the hosting web server rejected `POST /api/auth/register`. This is not caused by MongoDB, the Telegram token, or the Telegram chat ID. Set the host's runtime to Node.js 20+, build command to `npm install` (or `npm ci`), start command to `npm start`, and route the public domain—including `/api/*`—to that Node process. Static-only hosting cannot run registration.

The `.env` file is loaded from the project root even when `server.js` is started from another working directory. `MONGO_URI`/`MONGO_URL`, `TELEGRAM_TOKEN`, and `TELEGRAM_CHAT_ID` are accepted as compatibility aliases, although the canonical names in `.env.example` are recommended.

The 32 integration tests run against an ephemeral MongoDB replica set and verify account security, protected sidebar destinations, wallet settings, AI bot lifecycle, ledger idempotency, Telegram authorization and safe financial-status transitions, live market fallback, per-user notification isolation, SSE delivery and connection limits, email-queue retries, and transactional rollback when a required customer event cannot be saved.
