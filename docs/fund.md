# The fund

Back to the [README](../README.md).

The office turned into a small AI quant fund: real agents at desks (Claude Code, Codex, OpenCode and the rest) staffing an executive floor, a trading desk, research, a quant lab and risk, a paper portfolio they propose trades into, a risk engine in code that no agent can talk past, and an audit trail of everything. This page is the plan and the map: what of Agent Office it stands on, how the new parts fit, and the order they land in.

It is **paper trading only**. Nothing in the fund places a real order, and the execution interface refuses any venue that says it's live (see [Execution](#execution)).

## What it keeps from the office

The audit of Agent Office (October 2026) found most of what a multi-agent fund needs already there, built for coding agents:

| Agent Office piece | Where | What the fund uses it for |
| --- | --- | --- |
| Workers: a real CLI agent per desk, in a PTY, mirrored to every browser | `server/workers/`, `server/ptys.ts`, `server/ptyhost.ts` | Every analyst, trader and risk agent is a worker. No decorative NPCs: a desk is empty until a real session sits at it. |
| Providers: one adapter per agent CLI, with models and effort | `server/providers/`, `shared/providers.ts` | Claude Code, Codex, OpenCode (and Cursor, Grok, Pi…) staff any role. Nothing in the fund names a provider. |
| Persistent sessions: terminals outlive a restart, `workers.json`, resume | `server/workers/persist.ts`, `ptyhost.ts` | An agent keeps its conversation across restarts; its memory files keep its thesis across hires. |
| Hook events → status (`working`, `needs_input`, `done`…) and the "needs you" beacon | `server/hooks/`, `providers/*` | Process-level status under the fund's own desk status (researching, proposing…). |
| The loopback hook server, a per-worker token, and an MCP server every agent gets | `server/hooks/server.ts`, `bin/office-workers.js` | The agents' fund tools: the same token says who's calling, the same MCP server carries the fund's tools. |
| The meeting room: 2–5 workers through rounds (debate with a Skeptic seat, red/blue…) | `server/meetings.ts`, `shared/meetings.ts` | The investment committee: a pattern of its own, with BUY / HOLD / SELL ballots. |
| Board agents: a worker hired at a station with a standing brief | `shared/layout.ts` (`STATIONS`), `server/prompts.ts` | How a role's brief is handed to the agent that takes the desk. |
| Maps: the castle and the station place the same seats differently | `shared/maps/`, `docs/maps.md` | The trading floor: a map with desks by department, ticker walls and the committee room. |
| Registries for messages, keys, ticks, slices, routes and handlers | `docs/code-layout.md` | Every fund part is a module of its own, plugged in with one line per list. |
| Accounts, sessions, admins, voice, multiplayer, `/lite` | `server/accounts.ts`, `auth.ts` | Who may approve trades and change risk limits (admins), and the fund on a phone. |

What doesn't carry over: GitHub as the source of work (issues and PR boards), worktrees and pull requests as the unit of output, the merge gong. They stay for floors that are code projects; the fund's floors don't need them.

## Architecture

Six layers, each depending only on the ones under it:

```
 3D office & windows        src/client/features/fund/, world/, the trading-floor map
        │  WebSocket: fund.* messages (shared/protocol/fund.ts)
 Agent runtime              server/workers/, providers/, hooks/ — unchanged
        │  MCP tools → /fund/* on the loopback hook server, per-worker token
 Fund services              server/fund/fund.ts: proposals, desks, memory, committee
        │
 Portfolio & risk           shared/fund/book.ts, risk.ts (pure) · server/fund/venue.ts, exits.ts
        │
 Market data                server/fund/market/: one service, adapters per source
        │
 Persistence                server/fund/records.ts over journal.ts: hash-chained JSONL
```

- **Pure domain code lives in `src/shared/fund/`**: the types, the asset universe, valuing a portfolio, applying a fill, the risk engine and the proposal stages. No I/O, no clock (the time is passed in), so it's deterministic and tested directly, and the browser can show the same numbers the server enforces.
- **`src/server/fund/`** holds what keeps state: the records (`records.ts`: the ledger, proposals, NAV history and activity log), the paper venue, exits, market data, and `Fund` (`fund.ts`), the one service the rest of the office talks to (`ctx.fund`). It's building-wide: one fund, whichever floor you're on. Everything that changes the fund runs through `Fund` one action at a time, so two approvals can't both be sized against the same book.
- **Agents never touch the books.** They call tools; the tools land on `/fund/*` on the hook server, which checks the worker's own token and its role's permissions, then calls `Fund`. The only thing that changes cash or positions is a fill, and the only thing that makes a fill is the execution path below.

## The domain

### Agents, roles and departments

Every desk agent is a worker (a real session) with a **role** from the catalog in `shared/fund/roles.ts`:

| Department | Roles |
| --- | --- |
| 🏛️ Executive | Chief Investment Officer, Portfolio Manager, Chief Risk Officer, Skeptic (devil's advocate, permanent) |
| 📈 Trading | Crypto Trader, Equity Trader, Execution Trader, Arbitrage Analyst |
| 🔎 Research | Macro, Crypto, Equity, News, On-chain, Sentiment and Filings Analysts |
| 🧪 Quant lab | Quant Researcher, Strategy Researcher, Backtester, Factor Analyst, Data Scientist |
| 🛡️ Risk | Portfolio Risk, Market Risk, Liquidity Risk, Trade Auditor, Compliance |

A role has a brief (what the agent is for and what it produces), a focus, and **permissions**: which fund tools it may call. Most roles propose trades. The Skeptic, the Execution Trader, the Backtester, the Data Scientist and the risk desks don't: they read, watch, write down what they see and message the desks that do. Only the CIO and PM rule on proposals; the CIO, PM and Chief Risk Officer hand out work; risk agents explain the risk engine's verdicts but can't override them; nobody's tools reach the risk limits or the books.

Each staffed role has a **desk profile** (`DeskProfile`): role, department, the fund status the agent reports (`idle`, `researching`, `analyzing`, `backtesting`, `proposing`, `waiting`, `blocked`, `monitoring`, `finished`), its current assignment, thesis and confidence, and its track record (what it proposed, what filled, wins and losses, realized P&L). That sits beside the worker's process status (`working`, `needs_input`…), which the office already knows from hooks.

### Memory

An agent's memory is files the office writes for it, under the fund's folder, one folder per role (so a new hire into a role picks up where the last one left off):

```
agents/macro/
  thesis.md             the current thesis, rewritten when it changes
  thesis.jsonl          every change: when, the thesis, confidence, why
  observations.jsonl    what it noticed, with sources
  decisions.jsonl       its recommendations and proposals, and how they turned out
```

Agents add to them through tools (`fund_thesis`, `fund_observe`), not by editing the files, so every entry is stamped and attributed. They read them freely, or through `fund_memory`. Decisions are written by the office: each proposal a desk makes, withdraws, rules on or reviews. The messages between desks are one more journal beside them, `messages.jsonl`, and who holds which desk is `desks.json`.

### Portfolio

The paper book is the ledger replayed: capital paid in (a new fund starts with $1,000,000 from the office) and every fill since. Everything else (cash, positions, average cost, realized P&L, fees) follows from those (`shared/fund/book.ts`). Valuing it against the latest quotes gives the `PortfolioView`: NAV, cash, gross and net exposure, leverage, unrealized and daily P&L, drawdown from the high-water mark, and exposure by asset class, sector and correlation group. A person can pay capital in or take it out; that moves the NAV but isn't profit, so the day's start and the high-water mark move with it. The NAV is written down every 15 minutes, at every fill and at each new UTC day, which is where the day's P&L and the drawdown are measured from.

### Trade proposals

```
idea → research → proposed → risk_review → cio_review → user_approval → executing → monitoring → exited → reviewed
                                  └──────────────┴──────────────┴──→ rejected   (and withdrawn, expired, failed)
```

A proposal (`P-1`, `P-2`…) carries the asset, direction, size, entry, stop (its invalidation), target, horizon, thesis, catalyst, confidence, evidence and the strongest dissenting view. An idea needs only the asset, direction and thesis, and is filled in later. On submit a proposal goes straight through risk review (code, below). What passes waits on the CIO or PM to endorse it, when the fund requires it (the default) and one is at a desk; nobody rules on their own proposal. Then it waits on a person to approve it. A person may approve from CIO review without waiting, and that's on the record. Approving runs risk **again** against the book and the price as they are then, and fills on paper at what risk allows then, never more than was asked. While it's open the office watches its stop and target on every fresh price and exits it when either is hit. Once it's out, its author writes the post-trade review. A proposal nobody decides on expires after 24 hours (a setting).

### Risk

`shared/fund/risk.ts` is deterministic code. Given a proposal, the portfolio, the asset, its quote and the limits, it returns `approved`, `resized` or `rejected`, with every check it ran and the numbers:

- **Hard checks** (any failure rejects): a fresh price; the asset class allowed; shorts allowed; a stop on the right side of the entry (when stops are required); the drawdown and daily-loss halts not tripped; enough liquidity (daily traded value).
- **Caps** (each gives the most the trade may be; the smallest wins, and a trade cut below the minimum size is rejected): maximum position as a % of NAV; gross exposure per asset class; net exposure per correlation group; gross leverage; participation in daily volume; the most the trade may lose at its stop as a % of NAV; the top-3 positions' share of NAV.

The defaults, all editable: a position at most 10% of NAV; crypto 35% gross, equities 60%, ETFs 80%, commodities 20%, rates 40%; any correlation group 30% net; the top three positions 25%; leverage 1.5×; no new risk past a 15% drawdown or a 3% losing day; at least $5M traded a day, and at most 1% of it; at most 1% of NAV lost at the stop; a stop required; trades under $1,000 rejected; prices older than 30 minutes refused. A book already over a limit can always take risk off, back to flat.

Only people change the limits (admins, from the fund's Risk window), and every change goes in the ledger and the activity log with who made it and what it was before. Risk agents read the verdicts and explain them; they can't change them.

### Execution

`ExecutionVenue` (`server/fund/venue.ts`) is the interface a broker or exchange would implement. The only one is `paper`: it fills at the quote, moved against you by the slippage (5 bp by default), and charges the fee (5 bp). Orders are sized so what fills, slippage included, is what risk allowed. `Fund` won't start on a venue that reports `live: true`. Live execution is phase 3, behind its own strict approvals, and isn't started here.

Exits (`server/fund/exits.ts`) only ever reduce: an exit closes no more than its trade put on, nor more than the position still holds, so it can't open anything. Stops and targets close by themselves; a person can close one trade, or a whole position (every trade in it is marked exited at that fill).

### Market data

One service, `server/fund/market/`, that every agent and window reads, instead of each agent fetching what it likes. Adapters say which asset classes or data kinds they serve:

| Kind | Adapter now | Needs a key |
| --- | --- | --- |
| Crypto prices | Coinbase Exchange public API | no |
| Equity and ETF prices | Yahoo Finance chart API (unofficial, delayed) | no |
| Funding rates, open interest | OKX public API | no |
| Any price, offline | `mock`: a seeded random walk | no |
| Macro, news, on-chain, filings, liquidations, ETF flows | declared, `mock` until a real adapter lands | — |

Every quote says where it came from and when; mock data is labelled **MOCK** wherever it shows. The fund runs on one or the other, set in its settings: `public` (the sources above, no made-up signals mixed in) or `mock` (a simulated market running 60× fast, with simulated signals of every kind). Switching drops every price from the other. A new source is one adapter file and a line in the adapter list.

It only asks while it's needed: for ten minutes after anyone opens the fund or an agent asks for a price, and all the time while the fund holds something or a proposal is live. An office that never uses the fund calls out to nobody. Yahoo's quotes outside US market hours are the last close, as old as it is, so risk won't open an equity position then; stops are only acted on fresh prices. Liquidity for listed assets is the average traded value over the last few full sessions.

### Audit

The fund keeps four append-only JSONL journals in the office's data folder, `~/agent-office/.agent-office/fund/`, outside every project checkout the agents work in. Each line carries the hash of the one before:

| Journal | What's in it |
| --- | --- |
| `ledger.jsonl` | capital paid in and out, every fill, every change to the risk limits and the settings: the book and its rules are replayed from it |
| `proposals.jsonl` | each proposal as it went through each stage |
| `nav.jsonl` | the NAV over time, with the day's start and the high-water mark |
| `activity.jsonl` | every proposal, risk verdict, ruling, approval, fill, exit, limit change and review, with who did it |

Nothing is written until the fund is first used. The office checks every chain when it starts. A line cut short when the office stopped mid-write is dropped and noted; anything else that doesn't match (a line edited, removed or added by hand) stops the fund from trading, and the 💼 Fund window says which journal and which line, rather than trading on a book someone edited. To carry on, a person starts the fund over, which moves the old records aside to `fund-<time>/` rather than deleting them.

The chain makes tampering evident, not impossible: the agents run as the same user as the office, so one determined to could rewrite a journal and recompute its hashes. Their tools are the only way the fund lets them in, every tool call is attributed, and an edit that doesn't recompute the chain is caught.

## The 💼 Fund window

**☰ → 💼 Fund** opens the fund over the office, as a trading terminal. Along the top: the NAV, the day's P&L, the total return, the drawdown, the leverage, and whether prices are coming in (**LIVE DATA**, **DATA IDLE** or **MOCK DATA**). Badges say what you're looking at: **PAPER** always, **MOCK MARKET** on simulated prices, **HALTED** when a journal didn't check out. Keys **1**–**7** turn to a tab:

| Tab | What's on it |
| --- | --- |
| Overview | NAV, the day's and total P&L, cash, gross and net exposure, leverage and drawdown against their limits, fees paid; the NAV over time; the positions, with what each is up or down; exposure by asset class |
| Agents | Every role by department, staffed or vacant. A staffed desk shows its agent, what its process is doing and the status it reports, its assignment, thesis and confidence, and its record; **Memory** opens its thesis history, observations and decisions. Staff a vacant desk with an agent already at work or a new hire; **Hire** on the team bar staffs whichever of the core team (the CIO, the Macro and Crypto Analysts, the Quant Researcher and the Skeptic) is missing, in one go. Assign a task, send a message or release a desk. Underneath, the messages between the desks |
| Proposals | Waiting on your approval, with the CIO, open trades, ideas and research, finished. Each shows its thesis, catalyst, evidence and dissent, every risk check with its numbers, the CIO's and the person's rulings, its fill, its exit and review, and its history. Approve or reject it with a note for the record, or exit an open trade now. **Propose a trade yourself** goes through the same risk engine as an agent's |
| Risk | The book against each limit, exposure by correlation group, and the limits themselves, to change |
| Market | Every price with its source and age (**MOCK** marked, a price too old to trade on in red), the latest signals, and how each source is doing |
| Activity | The fund's own log, by kind: every proposal, verdict, ruling, fill, exit, limit change and review, and every thesis, observation, status, assignment, message and escalation from the desks, with who did it |
| Settings | The fund's name, fee and slippage, its market data (public or mock), whether a CIO or PM rules first, how long a proposal waits; paying capital in or taking it out; starting over |

Anyone in the office can watch. Only admins act: approve, reject, exit, close, propose, staff and release desks, assign and message them, change the limits or settings, move capital or start over. The office checks that itself, not the window (everyone on the shared password is an admin; with [accounts](../README.md#add-users), a Member only watches). When a trade waits on a person, or the fund has halted, a 💼 chip on the top bar says so to everyone in the building, with how many.

The window only watches while it's open: it keeps prices coming while you look, and lets go when you close it (**✕** or **Esc**, straight back to looking around).

## Agents at the desks

A desk is staffed by a real worker: an agent already at work in the office, or one hired for the role from the window's Agents tab. Each role is held by one worker at a time. Taking a role does three things:

- **The brief.** The agent is told who it is: the role's brief, its permissions, where its memory is, and to start by reading that memory and reporting its status. A new hire starts with it as its first prompt; an agent already at work gets it typed in.
- **The sign.** The role's sign (`🔎 Macro Analyst`) goes up over its desk, in its department's colour, and comes down when it's released. A new hire for a role takes the desk with the role's sign when it's free.
- **The tools.** Its `agent-office` MCP server lists the fund's tools its role allows (below). A worker without a role sees none of them, so coding agents' tool lists stay as they were.

When a worker goes home its desk is free again; the role's memory stays, and the next holder starts from the last thesis. The desks carry on when the fund is started over.

The office keeps the desks talking without anyone relaying:

- A message or an assignment is typed into the agent it's for, with who it's from and how to answer. Assignments come from the CIO, PM and CRO (or a person), and become the desk's current assignment.
- An escalation is a toast to everyone in the building and a message to the CIO.
- An agent hears what happened to its proposal: the risk verdict, a ruling, a fill, an exit, and when to write its review. When a proposal waits on the CIO, the CIO (or the PM, when the CIO wrote it) is told to rule on it. Nobody rules on their own proposal: a CIO's goes straight to a person.

Every one of these goes in the activity log, with who did it.

### The fund tools

What an agent at a desk can call, from its `agent-office` MCP server, or from the `office-fund` command on its PATH when its tools were listed before it took the desk (`office-fund help`, `office-fund portfolio`, `office-fund propose '{"symbol":"BTC",…}'`). Both go to `/fund/*` on the office's loopback hook server with the worker's own token, so the fund knows which worker called and what its role allows:

| Tool | Who | What it does |
| --- | --- | --- |
| `fund_portfolio`, `fund_quotes`, `fund_market` | anyone | the paper book, prices with their source and age, the market's signals |
| `fund_proposals`, `fund_activity`, `fund_desks`, `fund_memory` | anyone | proposals by stage or one in full, the log, who holds which desk, a role's memory |
| `fund_risk_check` | anyone | what the risk engine would say to a trade, without proposing it |
| `fund_status`, `fund_thesis`, `fund_observe` | a desk | report its status, change its thesis and confidence, write down what it saw |
| `fund_message`, `fund_inbox`, `fund_escalate` | a desk | message another desk, read what came in, escalate to the CIO and the room |
| `fund_review` | a desk | the post-trade review of its own exited trade |
| `fund_propose`, `fund_withdraw` | roles that propose | propose a trade or an idea (or fill an idea in), withdraw its own |
| `fund_rule` | CIO, PM | back or reject a proposal at CIO review |
| `fund_assign` | CIO, PM, CRO | hand a desk a task |

None of them approves a trade, changes a limit or touches the books: a person approves, and approving runs risk again.

## The plan

Each step is a pull request that leaves the office working.

**Phase 1: the MVP**

1. **Fund core** — this page; the pure domain (`shared/fund/`); the records, paper venue, exits, market data and the `Fund` service (`server/fund/`), as `ctx.fund`; tests. Nothing visible yet, and nothing on disk or on the network until it's used.
2. **Dashboards** ✅ — the fund's messages (`shared/protocol/fund.ts`) and their handlers (`server/ws/handlers/fund.ts`, where the admin check lives), the state slice, and [the 💼 Fund window](#the--fund-window) with its chip on the top bar.
3. **Agents at the desks** ✅ — [staffing a role](#agents-at-the-desks) (brief, permissions, memory folder, the sign over its desk), [the fund's tools](#the-fund-tools) on the agents' MCP server and the `office-fund` command, messages, assignments and escalations between the desks, the desk profiles, and the Agents tab.
4. **The investment committee** — the CIO or PM calls a meeting on a proposal; each seat casts BUY / HOLD / SELL with its confidence, argument, evidence and risk; the Skeptic always sits; the CIO sums it up.
5. **Strategies and backtests** — the strategy registry (idea → research → backtest → validation → paper → approved → retired), a backtest service (Sharpe, drawdown, win rate, profit factor, turnover), and their tabs.
6. **The trading floor** — the map: desks grouped by department with their signs, ticker walls and portfolio and risk screens, the CIO's office, the committee room, and a risk event you can see from across the floor.

**Phase 2**: confidence over time and performance scores per desk, research requests that track their answers, and agents that pick work up on a schedule.

**Phase 3**: richer data (news, on-chain, filings, macro, ETF flows), broker adapters, more of the office acting out the fund, and live execution behind strict approvals, if ever.
