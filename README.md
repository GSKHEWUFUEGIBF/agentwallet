# AgentWallet

**A spending-rules wallet for AI shopping agents, funded and settled through PayPal.**

AI agents are starting to buy things on our behalf, but handing an agent a payment method is a leap of faith. AgentWallet puts a rules layer between the agent and the money. You fund a wallet through PayPal, set what the agent may spend, and let it shop. Small purchases go through on their own, bigger ones wait for your one-tap approval, and anything outside your rules is blocked.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

## The problem

An agent that can pay can also overspend, be talked into a bad purchase, or be misled by text on a web page. Today the choice is "give it your card" or "don't let it buy". There is no middle ground that a normal person can set up in a minute.

## How it works

```
  you ──fund via PayPal Checkout──▶  WALLET  ◀──asks to buy──  AI agent (Claude)
                                       │
                          policy engine (plain code, not AI)
                    ┌──────────┬────────┴───────┬───────────┐
                  allowed     held            blocked
              pay merchant   wait for you   nothing spent
             (PayPal Payouts)  approve/decline
```

1. **Add funds.** The owner tops up the wallet through PayPal Checkout (Orders v2: create, approve, capture).
2. **Set rules.** An auto-approve limit, a per-purchase hard limit, a daily budget, allowed categories and blocked merchants.
3. **Give the agent a job.** "Buy a USB-C hub under $30." Claude searches a store catalog and asks the wallet to buy.
4. **The wallet decides, not the agent.** Every request is checked by a deterministic policy engine. The agent cannot change the rules, name its own price, or see a way around them.
5. **Settlement.** Allowed purchases are paid out through the PayPal Payouts API. Held purchases wait in the receipt tape for approval.

### Why the policy engine is plain code

The model only ever asks. Prices come from the catalog on the server, every tool call is validated, and the same item cannot be requested twice in a run. The demo catalog includes a deliberately hostile listing whose description tells AI agents to ignore the owner's rules. Even if an agent obeyed it, the wallet blocks the purchase. That is the point of the design: safety does not depend on the model behaving.

## PayPal and AI in this project

| Piece | What it does |
| --- | --- |
| PayPal Orders v2 (sandbox) | Funds the wallet. Creates an order, sends the owner to PayPal to approve, then captures it. The captured amount is checked against what was requested before any money is credited. |
| PayPal Payouts (sandbox) | Pays the merchant when a purchase is allowed or approved. The purchase id is the batch id, so a retry cannot pay twice. If the payout fails, nothing is deducted and the purchase is marked failed with PayPal's message. |
| Claude (Anthropic API, tool use) | The shopping agent. It has three tools: `check_wallet`, `search_catalog` and `request_purchase`. It plans, picks the best match for the job, and explains outcomes in plain language. |
| Policy engine (`src/policy.js`) | Decides allowed, held or blocked. Pure functions with unit tests. |

## Run it

You need Node.js 22 or newer.

```bash
git clone <this repo>
cd agentwallet
npm install
npm start
```

Open http://localhost:3000.

With no keys at all, the app runs in **mock mode**: a stand-in checkout page replaces PayPal, no money moves, and a simple keyword agent replaces Claude. The header always says which mode you are in. This lets you try every screen in a minute.

### Use the real PayPal sandbox and Claude

```bash
cp .env.example .env
```

Then fill in `.env`:

1. **PayPal sandbox.** In the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications/sandbox), create a Sandbox app and copy its client ID and secret into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
2. **A receiver for payouts.** Under Testing tools, Sandbox accounts, pick a sandbox account to receive merchant payments and put its email in `PAYPAL_MERCHANT_EMAIL`. In this demo every merchant payout goes to that one account. Leave it blank to simulate payouts instead.
3. **A buyer to pay with.** When you click "Add with PayPal", sign in at the sandbox checkout with a sandbox personal account.
4. **Claude.** Put an [Anthropic API key](https://console.anthropic.com/) in `ANTHROPIC_API_KEY`.

Also set `OWNER_KEY` to any long random string and `PUBLIC_URL` to the address you open the app at. Restart with `npm start`, enter the key in the box at the top of the page, and the footer now shows "PayPal sandbox" and "Claude".

| Variable | Purpose |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox app credentials. Both required for sandbox mode. |
| `PAYPAL_MERCHANT_EMAIL` | Sandbox account that receives payouts. Blank means payouts are simulated. |
| `OWNER_KEY` | Secret that protects everything that moves money or changes rules. **Required** when PayPal credentials are set; the app refuses to start without it. Anyone can view the wallet, but only someone with the key can add funds, run the agent, approve, decline or change rules. |
| `PAYPAL_MODE=mock` | Force mock mode even if credentials are set. |
| `ANTHROPIC_API_KEY` | Enables the Claude agent. |
| `ANTHROPIC_MODEL` | Model to use. Defaults to `claude-sonnet-5-5`. |
| `AI_MODE=demo` | Force the keyword demo agent even if a key is set. |
| `AGENT_RUNS_PER_HOUR` | Per-visitor limit on Claude runs. Defaults to 20. |
| `TRUST_PROXY` | Set to `1` only behind a trusted proxy such as Render (the included `render.yaml` does). Left unset, the per-visitor limit ignores `X-Forwarded-For`, so it cannot be spoofed. |
| `ALLOW_RESET=1` | Shows a "Reset demo data" button. |
| `PUBLIC_URL` | Public address of the app (for example `http://localhost:3000`), used for PayPal's return links. **Required** in sandbox mode, so a forged `Host` header cannot redirect the buyer. |
| `PORT`, `DATA_DIR` | Port, and where the JSON data file lives. |

The code only ever calls the PayPal **sandbox**. There is no live endpoint in it.

## The screens

A sidebar app with six views: **Dashboard** (wallet, agent, receipt tape), **Budgets & rules**, **Agents** (what the agent can and cannot do, and the demo store with its hostile listing), **Transactions** (searchable ledger with the reason for every decision), **Integrations** (what is connected: PayPal Orders, PayPal Payouts, Claude, owner key) and **Settings**.

## Try this in the demo

Add funds, then run these from the example chips:

- **Buy a USB-C hub under $30** is paid automatically.
- **Get a mechanical keyboard and a notebook**: the notebook is paid, the keyboard waits for your approval.
- **Order a standing desk** is blocked as over your per-purchase limit.
- **Buy the productivity bundle** is blocked, even though its listing tells agents to ignore the rules.

Then change the rules and run them again.

## Tests

```bash
npm test
```

40 tests cover the policy engine, the wallet flows (top-up, auto-pay, hold, approve, decline, daily budget, a double-spend race), the Claude tool-use loop, and the failure cases a payments app has to survive: owner-key checks, cross-site requests, approving after the rules tightened, a capture or payout that times out, a crash mid-payout, and a corrupt data file. The tests use mock PayPal and a scripted model client, so they need no keys or network. Run the app with your own keys to exercise the live PayPal and Claude paths.

## Deploy

`render.yaml` describes a one-click [Render](https://render.com) web service. Render generates an `OWNER_KEY` for you (find it in the service's Environment tab). Add your PayPal and Anthropic keys there too, and set `PUBLIC_URL` to your service address.

## Project layout

```
server.js          Express app and routes
src/policy.js      The rules engine (pure functions)
src/wallet.js      Balance, purchases, approvals; one money operation at a time
src/paypal.js      PayPal sandbox client (Orders, Payouts) with a mock mode
src/agent.js       Claude tool-use loop, plus the keyword demo agent
src/catalog.js     The fictional store
src/store.js       Small JSON-file persistence
public/            The web app (plain HTML, CSS and JavaScript)
tests/             Node's built-in test runner
```

## How money is protected

- **The agent cannot override the rules.** Prices and categories come from the server's catalog, and a deterministic policy engine decides. Approving a held purchase re-checks the rules, so a hard block can never be approved around.
- **Funds are reserved before PayPal is called**, and the intent is saved to disk first. If a payout times out or the server restarts mid-payout, the purchase shows "Waiting for PayPal to confirm" with the money still reserved, so it can never be paid twice. A payout PayPal definitively rejects gives the money back.
- **Top-ups are verified.** The wallet is credited only when PayPal reports the order and the capture both COMPLETED, in USD, for exactly the amount requested. A capture that times out can be retried safely, and the page does so automatically.
- **Owner-only actions need `OWNER_KEY`**, cross-site POSTs are refused, and agent runs are rate limited per visitor.

## Known limits

- It is a single-owner demo: one shared wallet. The owner key is one shared secret, not user accounts.
- Payout status is recorded when PayPal accepts the batch. This demo does not poll PayPal later to reconcile a batch that is delayed or fails afterwards.
- Merchants and the catalog are fictional, and all payouts go to one sandbox account.
- The daily budget resets at midnight UTC.
- State lives in a local JSON file. On a free Render instance it resets when the service restarts.

## Licence

MIT. See [LICENSE](LICENSE).
