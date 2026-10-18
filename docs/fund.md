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
 Fund services              server/fund/fund.ts: proposals, desks, memory, committee, the quant lab
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

A role has a brief (what the agent is for and what it produces), a focus, and **permissions**: which fund tools it may call. Most roles propose trades. The Skeptic, the Execution Trader, the Backtester, the Data Scientist and the risk desks don't: they read, watch, write down what they see and message the desks that do. Only the CIO and PM rule on proposals; the CIO, PM and Chief Risk Officer hand out work; the CIO, PM, Quant Researcher, Strategy Researcher and Backtester work on [the lab's strategies](#strategies-and-backtests); risk agents explain the risk engine's verdicts but can't override them; nobody's tools reach the risk limits or the books.

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

Agents add to them through tools (`fund_thesis`, `fund_observe`), not by editing the files, so every entry is stamped and attributed. They read them freely, or through `fund_memory`; [`fund_research`](#research) reads every desk's at once. Decisions are written by the office: each proposal a desk makes, withdraws, rules on or reviews. The messages between desks are one more journal beside them, `messages.jsonl`, and who holds which desk is `desks.json`.

### Portfolio

The paper book is the ledger replayed: capital paid in (a new fund starts with $1,000,000 from the office) and every fill since. Everything else (cash, positions, average cost, realized P&L, fees) follows from those (`shared/fund/book.ts`). Valuing it against the latest quotes gives the `PortfolioView`: NAV, cash, gross and net exposure, leverage, unrealized and daily P&L, drawdown from the high-water mark, and exposure by asset class, sector and correlation group. A person can pay capital in or take it out; that moves the NAV but isn't profit, so the day's start and the high-water mark move with it. The NAV is written down every 15 minutes, at every fill and at each new UTC day, which is where the day's P&L and the drawdown are measured from.

### Trade proposals

```
idea → research → proposed → risk_review → cio_review → user_approval → executing → monitoring → exited → reviewed
                                  └──────────────┴──────────────┴──→ rejected   (and withdrawn, expired, failed)
```

A proposal (`P-1`, `P-2`…) carries the asset, direction, size, entry, stop (its invalidation), target, horizon, thesis, catalyst, confidence, evidence and the strongest dissenting view. An idea needs only the asset, direction and thesis, and is filled in later. On submit a proposal goes straight through risk review (code, below). What passes waits on the CIO or PM to endorse it, when the fund requires it (the default) and one is at a desk; nobody rules on their own proposal. A proposal over 8% of NAV (a setting) needs [an investment committee's](#the-investment-committee) decision before an agent CIO or PM can rule on it. Then it waits on a person to approve it. A person may approve from CIO review without waiting, and that's on the record. Approving runs risk **again** against the book and the price as they are then, and fills on paper at what risk allows then, never more than was asked. While it's open the office watches its stop and target on every fresh price and exits it when either is hit. Once it's out, its author writes the post-trade review. A proposal nobody decides on expires after 24 hours (a setting).

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

The fund keeps seven append-only JSONL journals in the office's data folder, `~/agent-office/.agent-office/fund/`, outside every project checkout the agents work in. Each line carries the hash of the one before:

| Journal | What's in it |
| --- | --- |
| `ledger.jsonl` | capital paid in and out, every fill, every change to the risk limits and the settings: the book and its rules are replayed from it |
| `proposals.jsonl` | each proposal as it went through each stage |
| `nav.jsonl` | the NAV over time, with the day's start and the high-water mark |
| `committees.jsonl` | each investment committee as it went: called, every ballot, opened, decided or lapsed |
| `strategies.jsonl` | each quant lab strategy as it changed: registered, edited, every move from stage to stage, every new signal |
| `backtests.jsonl` | every backtest: its rules, universe, costs, results, and the source, range and hash of the prices it ran on |
| `activity.jsonl` | every proposal, risk verdict, ruling, approval, fill, exit, limit change, committee step, strategy move, backtest and review, with who did it |

The daily prices the backtests ran on are cached beside them in `history/`, for half a day; they're not a record, and the hash in each backtest says which prices it used.

Nothing is written until the fund is first used. The office checks every chain when it starts. A line cut short when the office stopped mid-write is dropped and noted; anything else that doesn't match (a line edited, removed or added by hand) stops the fund from trading, and the 💼 Fund window says which journal and which line, rather than trading on a book someone edited. To carry on, a person starts the fund over, which moves the old records aside to `fund-<time>/` rather than deleting them.

The chain makes tampering evident, not impossible: the agents run as the same user as the office, so one determined to could rewrite a journal and recompute its hashes. Their tools are the only way the fund lets them in, every tool call is attributed, and an edit that doesn't recompute the chain is caught.

## The 💼 Fund window

**☰ → 💼 Fund** opens the fund over the office, as a trading terminal. Along the top: the NAV, the day's P&L, the total return, the drawdown, the leverage, and whether prices are coming in (**LIVE DATA**, **DATA IDLE** or **MOCK DATA**). Badges say what you're looking at: **PAPER** always, **MOCK MARKET** on simulated prices, **HALTED** when a journal didn't check out. Keys **1**–**9** and **0** turn to the first ten tabs (Settings has no key):

| Tab | What's on it |
| --- | --- |
| Portfolio | NAV, the day's and total P&L, cash, gross and net exposure, leverage and drawdown against their limits, fees paid; the NAV over time; the positions, with what each is up or down; exposure by asset class. Then the P&L: each day's as a bar (best and worst days named); where it came from by asset, by desk and by strategy, realized on closed trades and open on the rest, with each bucket's closed wins; any realized P&L no trade accounts for; and the latest closed trades with their entry, exit, P&L and return |
| Agents | Every role by department, staffed or vacant. A staffed desk shows its agent, what its process is doing and the status it reports, its assignment, thesis and confidence, and its record; **Memory** opens its thesis history, observations and decisions. Staff a vacant desk with an agent already at work or a new hire; **Hire** on the team bar staffs whichever of the core team (the CIO, the Macro and Crypto Analysts, the Quant Researcher and the Skeptic) is missing, in one go. Assign a task, send a message or release a desk. Underneath, the messages between the desks |
| Research | [The desks' research](#research): **Ask a desk to research** something (an assignment, typed into its agent); what each staffed desk is doing now; every desk's thesis with its confidence and how far it moved; coverage by asset, as a heat bar, with the notes, the desks writing, ideas and live proposals, the position and the signals on each (click an asset for its notes); ideas still being researched; every research note, by department or asset, with its sources; and each desk's calls scored: hit rate, average confidence, Brier score, average return and realized P&L, then the latest calls |
| Proposals | Waiting on your approval, with the CIO, open trades, ideas and research, finished. Each shows its thesis, catalyst, evidence and dissent, every risk check with its numbers, the CIO's and the person's rulings, its fill, its exit and review, and its history. Approve or reject it with a note for the record, or exit an open trade now. **Propose a trade yourself** goes through the same risk engine as an agent's. A proposal a committee sat on says how it went |
| Committee | [Investment committees](#the-investment-committee), sitting and decided. Each shows its question and proposal, its seats (the Skeptic marked 😈) and who has voted, then, once the ballots are open, every ballot with its argument, evidence and risks, the tally and the decision. **Call a committee** puts a question or a proposal to the desks you tick, the Skeptic always among them. Open the ballots early, or decide one that waits on a person (or over its chair) |
| Strategies | The [quant lab's](#strategies-and-backtests) board: every strategy by stage (Idea, Research, Backtest, Validation, Paper trading, Approved, and Retired below) with its rules, universe and owner; its latest backtest (open it in Backtests) and whether that clears the validation bar; its signal and record on paper; its hypothesis, checks and history. **Register a strategy**, backtest one, move it to its next stage (the card says what its gate is waiting for), send it back to research or retire it |
| Backtests | **Run a backtest**, of a strategy or of rules tried out there. Every run with its Sharpe, out-of-sample Sharpe, CAGR, drawdown, profit factor, trades and whether it clears the bar; the one picked in full: its equity against buying and holding (log scale, out of sample shaded), the drawdown, the numbers in and out of sample, the bar's checks, its position now, its latest trades and the prices it ran on (source, range and hash) |
| Risk | The book against each limit, exposure by correlation group, and the limits themselves, to change |
| Market | Every price with its source and age (**MOCK** marked, a price too old to trade on in red), the latest signals, and how each source is doing |
| Activity | The fund's own log, by kind: every proposal, verdict, ruling, committee step, strategy move, backtest, fill, exit, limit change and review, and every thesis, observation, status, assignment, message and escalation from the desks, with who did it |
| Settings | The fund's name, fee and slippage, its market data (public or mock), whether a CIO or PM rules first, how long a proposal waits, how big a proposal must be (as a % of NAV) before an agent CIO needs a committee; the quant lab's validation bar and days on paper before a person may approve a strategy; paying capital in or taking it out; starting over |

Anyone in the office can watch. Only admins act: approve, reject, exit, close, propose, call and decide committees, register, backtest and move strategies, staff and release desks, assign and message them, change the limits or settings, move capital or start over. The office checks that itself, not the window (everyone on the shared password is an admin; with [accounts](../README.md#add-users), a Member only watches). When a trade waits on a person, or the fund has halted, a 💼 chip on the top bar says so to everyone in the building, with how many.

The window only watches while it's open: it keeps prices coming while you look, and lets go when you close it (**✕** or **Esc**, straight back to looking around). [The trading floor's](#the-trading-floor) screens watch too, while you're on it.

## Agents at the desks

A desk is staffed by a real worker: an agent already at work in the office, or one hired for the role from the window's Agents tab. Each role is held by one worker at a time. Taking a role does three things:

- **The brief.** The agent is told who it is: the role's brief, its permissions, where its memory is, and to start by reading that memory and reporting its status. A new hire starts with it as its first prompt; an agent already at work gets it typed in.
- **The sign.** The role's sign (`🔎 Macro Analyst`) goes up over its desk, in its department's colour, and comes down when it's released. A new hire for a role takes the desk with the role's sign when it's free; otherwise, on a map with a table for each department ([the trading floor](#the-trading-floor)), a free seat at its department's table.
- **The tools.** Its `agent-office` MCP server lists the fund's tools its role allows (below). A worker without a role sees none of them, so coding agents' tool lists stay as they were.

When a worker goes home its desk is free again; the role's memory stays, and the next holder starts from the last thesis. The desks carry on when the fund is started over.

The office keeps the desks talking without anyone relaying:

- A message or an assignment is typed into the agent it's for, with who it's from and how to answer. Assignments come from the CIO, PM and CRO (or a person), and become the desk's current assignment.
- An escalation is a toast to everyone in the building and a message to the CIO.
- An agent hears what happened to its proposal: the risk verdict, a ruling, a fill, an exit, and when to write its review. When a proposal waits on the CIO, the CIO (or the PM, when the CIO wrote it) is told to rule on it. Nobody rules on their own proposal: a CIO's goes straight to a person.
- A committee seat is told when it's called (with the proposal in full), when the ballots open (with every ballot), and what was decided; the chair is told when it's its turn to decide.

Every one of these goes in the activity log, with who did it.

### The fund tools

What an agent at a desk can call, from its `agent-office` MCP server, or from the `office-fund` command on its PATH when its tools were listed before it took the desk (`office-fund help`, `office-fund portfolio`, `office-fund propose '{"symbol":"BTC",…}'`). Both go to `/fund/*` on the office's loopback hook server with the worker's own token, so the fund knows which worker called and what its role allows:

| Tool | Who | What it does |
| --- | --- | --- |
| `fund_portfolio`, `fund_quotes`, `fund_market` | anyone | the paper book, prices with their source and age, the market's signals |
| `fund_proposals`, `fund_activity`, `fund_desks`, `fund_memory` | anyone | proposals by stage or one in full, the log, who holds which desk, a role's memory |
| `fund_research` | anyone | [the research](#research): every desk's thesis now, the latest notes, coverage by asset and each desk's calls scored against its confidence, narrowed to an asset or a role |
| `fund_risk_check` | anyone | what the risk engine would say to a trade, without proposing it |
| `fund_status`, `fund_thesis`, `fund_observe` | a desk | report its status, change its thesis and confidence, write down what it saw |
| `fund_message`, `fund_inbox`, `fund_escalate` | a desk | message another desk, read what came in, escalate to the CIO and the room |
| `fund_review` | a desk | the post-trade review of its own exited trade |
| `fund_propose`, `fund_withdraw` | roles that propose | propose a trade or an idea (or fill an idea in), under a strategy on paper with its `strategyId`; withdraw its own |
| `fund_rule` | CIO, PM | back or reject a proposal at CIO review |
| `fund_assign` | CIO, PM, CRO | hand a desk a task |
| `fund_committees` | anyone | the committees sitting and the latest finished, or one in full (while it votes, only your own ballot) |
| `fund_ballot` | a seated desk | cast or revise its BUY / HOLD / SELL ballot |
| `fund_committee`, `fund_committee_close`, `fund_decide` | CIO, PM | call a committee, open its ballots early, decide it |
| `fund_strategies`, `fund_backtests`, `fund_history` | anyone | the lab's strategies (or one in full, with the validation bar's checks), its backtests (or one with its curve, trades and the prices it ran on), an asset's daily closes |
| `fund_backtest` | a desk | backtest a strategy's rules, or rules and a universe given here |
| `fund_strategy`, `fund_strategy_stage` | CIO, PM, Quant and Strategy Researchers, Backtester | register or edit a strategy, move it through the lifecycle |

None of them approves a trade, changes a limit or touches the books: a person approves, and approving runs risk again.

## Research

The fund's research is what the desks write in their memory, gathered across every role (`shared/fund/research.ts`, `server/fund/research.ts`). The window's Research tab and the `fund_research` tool show the same thing:

- **Theses.** Each desk's thesis now, its confidence, the confidence its last thesis had (so you can see a desk turn), why it changed, and how many it has written.
- **Notes.** Every observation (`fund_observe`), newest first, with the desk, the asset and the sources. Only a web address is a link.
- **Coverage.** Every asset the fund watches, holds, writes about, signals on or proposes. The ones it holds come first, then the hottest: notes, plus twice the ideas and live proposals, plus the signals. Each asset shows who wrote about it and the latest note.
- **Ideas.** Proposals still at Idea or Research.
- **Calls.** Every trade a desk proposed that has closed is a call, scored against the confidence it was proposed with. Per desk: calls, hit rate, average confidence, average return, realized P&L and the **Brier score**, the mean of (confidence as a chance − 1 if it made money, else 0)². Zero is perfect; 0.25 is what always saying 50% scores, so a desk below it says more than a coin. A person's own trades aren't scored.

To ask for research, tell a desk from the tab (or have the CIO, PM or CRO use `fund_assign`). It's an assignment like any other: typed into the agent, its current task on the Agents tab, and in the log. What comes back lands here as the desk writes it.

It reads the memory files on disk, so the window asks for it when the tab opens, again a few seconds after a desk writes a thesis or a note or a trade closes, and at least once a minute while you look. Nothing in it moves money or changes a desk's memory.

## The investment committee

When a decision is bigger than one desk, the CIO or PM (with `fund_committee`), or a person from the Committee tab, calls an investment committee (`C-1`, `C-2`…): a question put to some of the desks, usually about a proposal.

- **The seats.** The desks it asks, every staffed desk by default, and **the Skeptic, always**: there's no committee without one, and the Skeptic is told to make the strongest case against, whatever it privately thinks. The CIO or PM who calls it chairs and doesn't vote; when a person calls it, people decide.
- **Sealed ballots.** Each seat is told the question and the proposal in full, and casts **BUY**, **HOLD** or **SELL** with its confidence, its argument, its evidence and at least one risk that would make it wrong (`fund_ballot`). While the vote is on, a seat sees only its own ballot and who else has voted, and the log says who voted but not how, so nobody votes with the room.
- **The ballots open** when every seat has voted, when voting time runs out (15 minutes by default), or when the chair or a person opens them early. Then every seat sees every ballot and the tally: how many of each, a score from −100 (everyone sure it's a SELL) to +100 (everyone sure it's a BUY) weighted by confidence, the vote with the most confidence behind it, and who dissented or didn't vote. A seat may revise its ballot until the decision, and it's marked revised.
- **The decision.** The chair decides BUY, HOLD or SELL with a summary of what the committee found and the dissent (`fund_decide`); a person may decide any committee. Deciding against the ballots is allowed, and flagged in the log. The seats and the desk whose proposal it was are told. A committee nobody decides in time (as long as its vote ran, and at least 10 minutes) lapses, its ballots on the record.

A committee advises: it never places, sizes or approves a trade. One rule about it is code: an agent CIO or PM can't rule on a proposal bigger than **8% of NAV** (a setting; 0 turns it off) until a committee has decided on it, and is told so when it's asked to rule. People are never held to it. Every committee, ballot and decision is in `committees.jsonl` (see [Audit](#audit)) and the activity log, and each desk's part (`called`, `voted`, `decided`) goes in its memory.

## Strategies and backtests

The quant lab keeps the fund's systematic strategies (`S-1`, `S-2`…), each a set of rules in code rather than an agent's judgment, and the backtests behind them (`B-1`, `B-2`…). The Quant Researcher, the Strategy Researcher, the CIO and the PM register strategies (`fund_strategy`) and walk them through a fixed lifecycle (`fund_strategy_stage`); the Backtester validates other desks' strategies; any desk can run a backtest (`fund_backtest`) and read the lab (`fund_strategies`, `fund_backtests`, `fund_history`). People do all of it from the Strategies and Backtests tabs.

**The rules.** A strategy is a kind with its params, a universe of up to 12 of the fund's assets (equally weighted), whether it may go short, and an optional volatility target (each position scaled to that annualized volatility over the last 20 days, never above full size). The kinds, in `shared/fund/strategy.ts`:

| Kind | Params (defaults) | Positions |
| --- | --- | --- |
| `trend` | fast, slow (20, 100 days) | long while the fast moving average is above the slow one; short below it, if shorts are allowed |
| `momentum` | lookback, threshold (90 days, 0%) | long when the return over the lookback beats the threshold; short when it's below minus the threshold |
| `mean-reversion` | window, entry, exit (20 days, z 2, z 0.5) | buys a close stretched below its average and sells it back near the average; the mirror image short |
| `breakout` | entry, exit (55, 20 days) | long on a close above the entry window's highest close, out on one below the exit window's lowest; the mirror image short |
| `buy-hold` | none | always long: the yardstick |

A new kind is one entry in that list; the tests check every kind never looks ahead.

**The backtest** (`shared/fund/backtest.ts`, pure and deterministic) runs on daily closes. Each position is decided at a close from that close and the ones before it, never a later one, and held to the next close. Costs, never less than the paper venue's fee plus slippage, are charged on every change of position. It reports the whole period, the first 70% (in sample), the last 30% (out of sample, the part to trust) and buying and holding the same assets: total return, CAGR, volatility, Sharpe and Sortino (annualized, against no risk-free rate), max drawdown and the longest time under water, Calmar, closed trades, win rate, profit factor, average trade, turnover a year and exposure. It tests five years of history by default, or the validation bar's if that's longer (1 to 15).

**The prices** come from the same free sources as the fund's quotes: Coinbase's daily candles for crypto, Yahoo Finance for listed assets, or in the mock market a seeded simulation, marked **MOCK** wherever it shows. They're cached in the fund's folder (`history/`) for half a day. Every backtest records each series' source, range, number of closes and a hash of them, so a run can be repeated and checked. A source that fails says so; the lab never quietly falls back to made-up prices.

**The lifecycle** has a gate in code at each step (`checkMove`):

```
idea → research → backtest → validation → paper → approved
  └──────────── back to research, or retired, from any of them ────────────┘
```

- **Backtest** needs a backtest of its rules as they are now, and **validation** one over enough history (2 years by default).
- **Paper** needs a backtest of its current rules that clears the **validation bar**, and **four eyes**: the desk that wrote or owns a strategy can't put it on paper; another lab desk (usually the Backtester) or a person does. The bar, by default: 2 years tested, 10 closed trades, an out-of-sample Sharpe of 0.5, a max drawdown of 30% at most and a profit factor of 1.1, all on real prices when the fund trades on real ones.
- **Approved** is a person's call alone, after its days on paper (14 by default).
- Its rules can change until it's on paper; changing them in validation sends it back to backtest. Back in research, a strategy loses its signal and its time on paper starts again. Its owner, the CIO or PM, or a person retires it.

The bar and the days on paper are in ⚙️ Settings, for people only.

**On paper**, a strategy has a **signal**: the position its rules hold on each of its assets after the latest close, worked out again on fresh closes about once a day. When it flips, the activity log says so and the strategy's owner desk is told, with the open trades under it. A desk proposes a trade under a strategy with `fund_propose` and its `strategyId`. The fund refuses one the signal doesn't back: a long while it's flat or short, an asset outside its universe, or a strategy not on paper. Those trades then go through risk and a person's approval like any other, since a strategy never places, sizes or approves a trade itself. Each strategy's card shows its record on paper: proposed, open, closed, won and realized P&L.

Every strategy as it changed is in `strategies.jsonl`, and every backtest in `backtests.jsonl`, both hash-chained (see [Audit](#audit)). The moves and runs are in the activity log, and each desk's part (`strategy`, `backtested`) goes in its memory.

## The trading floor

**⚙️ Settings → 🏢 Building → Map → 📈 Trading floor** makes the building the fund's trading floor, high up a tower (see [the map](maps.md#the-trading-floor)). It's a map like the castle and the station, so the office comes along whole: every worker on it is a real agent at a real seat, and an empty seat is empty.

- **The video wall**, over the principal's desk at the far end. Along the top, a **ticker** the width of the hall: the fund's NAV and its day, **PAPER**, then every price it holds (marked ●) or watches, green up and red down, led by a warning whenever risk needs looking at. Under it the **heatmap** (what's held, sized by its value and colored by the day's move, outlined in amber; what's only watched shares a third as much again), the **portfolio** (NAV, the day and since inception, cash, gross and net, leverage and drawdown, the NAV over time, and the positions) and the **risk board** (the five limits the Risk tab shows, as bars that turn amber at 80% of a limit and red past it, with the reasons underneath).
- **The rooms.** The CIO's office, with the 🏛️ Executive desks and the **trade pipeline** on its wall: how many proposals are at each step of the workflow, from idea through research, proposal, risk review, CIO review, your approval, paper execution and monitoring to exit and review, which ones, and the ones stopped short. The risk room, with the 🛡️ Risk desks, a second risk board and the **beacon**. The 🧪 quant lab, its **strategies** on the wall (each one's stage, its backtest's Sharpe and its record on paper) and the desks' **theses** with their confidence on the other side. The 🗳️ investment committee's room, the meeting table, with its **committees** (the question, who has voted, and the BUY / HOLD / SELL split once the ballots are open) and every **desk** by department, with its status, across the wall.
- **The desks.** A table to each department, its name hung over it: 🏛️ Executive (3 seats), 🛡️ Risk (5), 📈 Trading (6), 🔎 Research (8), 💻 Hot desks (4, the office's back office seats, so they open once that floor's back office is built out) and 🧪 Quant lab (6). Staff a role with a new hire from [the Agents tab](#agents-at-the-desks) and it sits at its department's table (the Skeptic with the Executive desks), or hire a worker into a seat yourself (**E** at its **+**) and give it a role. A placard over a staffed desk's monitors says which role it holds, in its department's color.
- **The beacon**, on the risk room's corner, is worked out by code the way risk's checks are, never by a model: green and still inside the limits; amber and pulsing when a limit is at 80% or more of itself, or risk turned a proposal down in the last hour; red, flashing and turning, its light on, when a limit is broken, a loss limit is hit, or trading has halted. You can see it from anywhere on the floor, and the ticker leads with why.

The screens follow the fund about once a second at most, and only read it: nothing on the floor changes the fund, and they need nobody to be an admin. They watch the fund while you're on the floor, as the window does while it's open, and say they're waiting for it until it's there.

What the screens make of the fund is pure code in `shared/fund/floor.ts` (the alarm, the ticker, the heatmap's tiles and its treemap, the pipeline, the desks by department), tested in `tests/trading-floor.test.ts`. `features/fund/floor.ts` finds the screens by the `feed` the world marks them with, paints them (`floor-paint.ts`), sets the beacon and hangs the placards; the map itself is `shared/maps/floor.ts` and `client/world/floor/`.

## The plan

Each step is a pull request that leaves the office working.

**Phase 1: the MVP**

1. **Fund core** — this page; the pure domain (`shared/fund/`); the records, paper venue, exits, market data and the `Fund` service (`server/fund/`), as `ctx.fund`; tests. Nothing visible yet, and nothing on disk or on the network until it's used.
2. **Dashboards** ✅ — the fund's messages (`shared/protocol/fund.ts`) and their handlers (`server/ws/handlers/fund.ts`, where the admin check lives), the state slice, and [the 💼 Fund window](#the--fund-window) with its chip on the top bar.
3. **Agents at the desks** ✅ — [staffing a role](#agents-at-the-desks) (brief, permissions, memory folder, the sign over its desk), [the fund's tools](#the-fund-tools) on the agents' MCP server and the `office-fund` command, messages, assignments and escalations between the desks, the desk profiles, and the Agents tab.
4. **The investment committee** ✅ — [committees](#the-investment-committee) (`shared/fund/committee.ts`, `server/fund/committee.ts`): sealed BUY / HOLD / SELL ballots with confidence, argument, evidence and risks, the Skeptic always seated, a confidence-weighted tally, the chair's decision, the size gate on an agent CIO's ruling, the committee tools, and the Committee tab.
5. **Strategies and backtests** ✅ — [the quant lab](#strategies-and-backtests): strategy kinds as rules in code and a deterministic backtest engine with no look-ahead, costs and an out-of-sample split (`shared/fund/strategy.ts`, `backtest.ts`); daily price history from the public sources or the mock market, hashed (`server/fund/history.ts`); the strategy registry and its gated lifecycle, the validation bar, four eyes, signals on paper that a strategy's trades must follow (`server/fund/strategies.ts`); the lab tools; and the Strategies and Backtests tabs.
6. **Research and P&L** ✅ — [the research](#research) gathered from every desk's memory, coverage by asset and calls scored with a Brier score (`shared/fund/research.ts`, `server/fund/research.ts`); P&L by day, asset, desk and strategy, reconciled to the book after fees (`shared/fund/pnl.ts`); `fund_research`; the Research tab, and the P&L on the Portfolio tab.
7. **The trading floor** ✅ — [the map](#the-trading-floor) (`shared/maps/floor.ts`, `client/world/floor/`): a tower floor with the city outside, desks by department with their signs, a video wall with the ticker, the heatmap, the portfolio and risk, glass rooms for the CIO, risk, the quant lab and the committee with the pipeline, strategies, theses, committees and desks on their walls, placards over the staffed desks, and a risk beacon you can see from across the floor (`shared/fund/floor.ts`, `features/fund/floor.ts`).

**Phase 2**: research requests that track their answers, and agents that pick work up on a schedule.

**Phase 3**: richer data (news, on-chain, filings, macro, ETF flows), broker adapters, more of the office acting out the fund, and live execution behind strict approvals, if ever.
