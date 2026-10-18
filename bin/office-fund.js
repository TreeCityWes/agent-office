#!/usr/bin/env node
// office-fund: the paper-trading fund's tools, for the agents at its desks (docs/fund.md#the-fund-tools):
// the book, the market, proposals and the risk engine's view of a trade, the desks and their memory,
// messages between desks, escalations. The office puts it on every worker's PATH, and the agent-office
// MCP server (office-workers.js) serves the same as fund_* tools to a worker holding a fund role, only
// those its role may use. It talks to /fund/<tool> on the office's hook server
// (src/server/hooks/fund.ts) with the worker's own id and token. Plain Node, no build step, no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { officeEnv, refusal, send } from './office-workers.js';

const TIMEOUT_MS = 30_000;

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const ID = str('A proposal id, like P-12.');
const read = { readOnlyHint: true, openWorldHint: false };
const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const schema = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

/** The fund's tools: each one's route on the office, and the MCP description an agent reads. */
export const FUND_TOOLS = [
  {
    name: 'fund_portfolio',
    route: 'GET portfolio',
    title: 'Fund portfolio',
    description: "The fund's paper book right now: NAV, cash, P&L (day, total, realized, unrealized), gross and net exposure, leverage, drawdown, every position with its P&L, exposure by asset class, sector and correlation group, and the risk limits it trades under.",
    inputSchema: schema({}),
    annotations: read,
  },
  {
    name: 'fund_quotes',
    route: 'GET quotes',
    title: 'Quotes',
    description: "The fund's prices: one per symbol, with its source, when it was priced and whether it's delayed or MOCK (mode: mock means a simulated market). Leave symbols out for everything it prices.",
    inputSchema: schema({ symbols: { type: 'array', items: { type: 'string' }, description: 'Symbols, like ["BTC", "NVDA"].' } }),
    annotations: read,
  },
  {
    name: 'fund_market',
    route: 'GET market',
    title: 'Market data',
    description: "The fund's market data beyond prices: signals (funding, open interest, liquidations, ETF flows, macro, news, on-chain, filings, sentiment), the sources and how they're doing, and with a symbol its recent price history.",
    inputSchema: schema({ kind: str('One signal kind: funding, open_interest, liquidations, etf_flows, macro, news, onchain, filings or sentiment.'), symbol: str('One symbol: its signals and price history.') }),
    annotations: read,
  },
  {
    name: 'fund_proposals',
    route: 'GET proposals',
    title: 'Trade proposals',
    description: "The fund's trade proposals, live and recent: each one's stage, symbol, side, size, author, thesis and the risk engine's verdict. With an id, the whole proposal (evidence, dissent, every risk check, rulings, fills, history) and its activity.",
    inputSchema: schema({ id: ID, stage: str('Only these stages, comma-separated: idea, research, proposed, risk_review, cio_review, user_approval, executing, monitoring, exited, reviewed, rejected, withdrawn, expired, failed.') }),
    annotations: read,
  },
  {
    name: 'fund_activity',
    route: 'GET activity',
    title: 'Fund activity',
    description: "The fund's audit log, newest last: proposals, risk verdicts, rulings, fills, exits, theses, observations, messages, escalations. Narrow it to a proposal, a symbol or a kind.",
    inputSchema: schema({ proposalId: ID, symbol: str('One symbol.'), kind: str('One kind: proposal, risk, ruling, fill, exit, thesis, observation, status, assignment, message, escalation, committee, strategy, backtest, review, system.'), limit: { type: 'integer', minimum: 1, maximum: 200 } }),
    annotations: read,
  },
  {
    name: 'fund_risk_check',
    route: 'POST risk-check',
    title: 'Risk check',
    description: "What the fund's risk engine would say about a trade right now, without proposing it: approved, resized (to what) or rejected, and every check with its numbers. The engine is code with fixed limits; check before you propose.",
    inputSchema: schema({ symbol: str('Like BTC or NVDA.'), side: { type: 'string', enum: ['long', 'short'] }, sizeUsd: num('How big, in USD.'), stop: num('Where the idea is wrong.'), target: num('Where it pays.') }, ['symbol', 'side', 'sizeUsd']),
    annotations: read,
  },
  {
    name: 'fund_desks',
    route: 'GET desks',
    title: 'Fund desks',
    description: "Who holds which of the fund's roles, what each says it's doing (status, note, assignment), its thesis and confidence, and every role's track record (proposed, filled, wins and losses, realized P&L). Use the role ids here for fund_message and fund_memory.",
    inputSchema: schema({}),
    annotations: read,
  },
  {
    name: 'fund_memory',
    route: 'GET memory',
    title: 'Desk memory',
    description: "A role's memory: its thesis history, its observations and its decisions, newest first, and its track record. Yours when role is left out. It outlives whoever held the role, so read it when you start.",
    inputSchema: schema({ role: str('A role id (macro, cio, quant…), as fund_desks lists them.') }),
    annotations: read,
  },
  {
    name: 'fund_status',
    route: 'POST status',
    title: 'Set desk status',
    description: "Says what you're doing at your desk, for the fund window and the other desks: idle, researching, analyzing, backtesting, proposing, waiting, blocked, monitoring or finished, and a line on what.",
    inputSchema: schema({ status: { type: 'string', enum: ['idle', 'researching', 'analyzing', 'backtesting', 'proposing', 'waiting', 'blocked', 'monitoring', 'finished'] }, note: str('What, in a line.') }, ['status']),
    annotations: act,
  },
  {
    name: 'fund_thesis',
    route: 'POST thesis',
    title: 'Update thesis',
    description: "Writes your current thesis (your view, for your role) and your confidence in it to your memory, and tells the fund. Update it whenever your view changes, and say why.",
    inputSchema: schema({ thesis: str('Your view, with the reasoning.'), confidence: num('0 to 100.'), why: str('What changed it.') }, ['thesis']),
    annotations: act,
  },
  {
    name: 'fund_observe',
    route: 'POST observe',
    title: 'Record an observation',
    description: 'Keeps something you noticed in your memory and the fund\'s log: a data point, a headline, a risk, a case against a trade. Give sources and numbers, and tag the symbol or proposal it bears on.',
    inputSchema: schema({ text: str('What you noticed.'), sources: { type: 'array', items: { type: 'string' }, description: 'URLs or where it came from.' }, symbol: str('The symbol it bears on.'), proposalId: ID }, ['text']),
    annotations: act,
  },
  {
    name: 'fund_message',
    route: 'POST message',
    title: 'Message a desk',
    description: "Sends a message to another desk: it's typed into that agent's session and kept in its inbox. Ask for research, share a finding, challenge a trade. Name the desk by role id (macro, cio, skeptic…) or its worker's name.",
    inputSchema: schema({ to: str('A role id or a worker name, as fund_desks lists them.'), text: str('The message.'), proposalId: ID }, ['to', 'text']),
    annotations: act,
  },
  {
    name: 'fund_inbox',
    route: 'GET inbox',
    title: 'Desk inbox',
    description: 'The messages and assignments sent to your role, newest first.',
    inputSchema: schema({}),
    annotations: read,
  },
  {
    name: 'fund_escalate',
    route: 'POST escalate',
    title: 'Escalate',
    description: 'Raises something with the people running the fund and the CIO: a toast for everyone in the office and a warning in the fund\'s log. For what needs a human: a threat to a position, a broken process, a decision above your desk.',
    inputSchema: schema({ text: str('What, and what you need.'), proposalId: ID }, ['text']),
    annotations: act,
  },
  {
    name: 'fund_review',
    route: 'POST review',
    title: 'Post-trade review',
    description: 'Reviews one of your trades once it has exited: did the thesis hold (whatever the P&L did), and what it taught. It goes on the proposal and your record.',
    inputSchema: schema({ id: ID, thesisHeld: { type: 'boolean' }, lessons: str('What it taught, in a sentence or more.') }, ['id', 'thesisHeld', 'lessons']),
    annotations: act,
  },
  {
    name: 'fund_propose',
    route: 'POST propose',
    title: 'Propose a trade',
    description:
      'Puts a paper trade forward. It goes to the risk engine at once (which may resize or reject it by its limits), then to the CIO or PM if one is at a desk, then to a person, who alone approves it. ' +
      'Give a stop, a target, your confidence, the horizon, the evidence and the strongest case against. idea: true files it as an idea for research instead; call again with its id and the missing fields to propose it.',
    inputSchema: schema({
      id: str('An idea of yours (P-12) to propose, with the fields it lacked.'),
      symbol: str('Like BTC, ETH, NVDA, SPY.'),
      side: { type: 'string', enum: ['long', 'short'] },
      sizeUsd: num('How big, in USD.'),
      entry: num('The price to go in at; at the market when left out.'),
      stop: num('Where the idea is wrong: it exits there.'),
      target: num('Where it pays: it exits there.'),
      thesis: str('Why, in a paragraph.'),
      catalyst: str('What makes it move, and when.'),
      confidence: num('0 to 100.'),
      horizon: str('How long to hold it: 3d, 2w, 3m.'),
      evidence: { type: 'array', items: { type: 'string' }, description: 'The facts it rests on, each with its source.' },
      dissent: str('The strongest case against.'),
      strategyId: str('The quant lab strategy it follows, like S-2: it must be on paper, and the trade must go its signal’s way.'),
      idea: { type: 'boolean', description: 'File it as an idea for research, not a trade yet.' },
    }),
    annotations: act,
  },
  {
    name: 'fund_withdraw',
    route: 'POST withdraw',
    title: 'Withdraw a proposal',
    description: 'Takes one of your proposals back before it trades.',
    inputSchema: schema({ id: ID, note: str('Why.') }, ['id']),
    annotations: act,
  },
  {
    name: 'fund_rule',
    route: 'POST rule',
    title: 'Rule on a proposal',
    description: "Your ruling, as CIO or PM, on a proposal at CIO review: approve backs it on to a person for the final approval; reject turns it down. Give your reasons: they go on the record and to its author. You can't rule on your own proposals, and you can't change the risk engine's sizing.",
    inputSchema: schema({ id: ID, decision: { type: 'string', enum: ['approve', 'reject'] }, note: str('Your reasons.') }, ['id', 'decision']),
    annotations: act,
  },
  {
    name: 'fund_assign',
    route: 'POST assign',
    title: 'Assign research',
    description: "Hands a desk a task (research, a backtest, a re-underwrite of a position): it's typed into that agent's session, shown on its desk as its assignment, and kept in its inbox. Say what you need back and by when.",
    inputSchema: schema({ to: str('A role id or a worker name, as fund_desks lists them.'), text: str('The task, complete on its own.'), proposalId: ID }, ['to', 'text']),
    annotations: act,
  },
  {
    name: 'fund_committees',
    route: 'GET committees',
    title: 'Investment committees',
    description: "The investment committees sitting and the latest finished, or one by id: its question, seats, who has voted, the ballots once they're open, the tally and the decision. While a committee votes, you see only your own ballot.",
    inputSchema: schema({ id: str('A committee, like C-3.') }),
    annotations: read,
  },
  {
    name: 'fund_ballot',
    route: 'POST ballot',
    title: 'Cast a committee ballot',
    description:
      "Your ballot on a committee you sit on: BUY, HOLD or SELL, how sure you are, your argument, the evidence and the risks that would make you wrong. It stays sealed until every seat has voted or voting closes; after that you may revise it until the decision. Vote what you think, not what the room thinks.",
    inputSchema: schema(
      {
        id: str('The committee, like C-3.'),
        vote: { type: 'string', enum: ['BUY', 'HOLD', 'SELL'] },
        confidence: num('0 to 100.'),
        argument: str('Why, in a few sentences.'),
        evidence: { type: 'array', items: { type: 'string' }, description: 'The facts it rests on, each with its source.' },
        risks: { type: 'array', items: { type: 'string' }, description: 'What would make this vote wrong.' },
      },
      ['id', 'vote', 'confidence', 'argument', 'risks'],
    ),
    annotations: act,
  },
  {
    name: 'fund_committee',
    route: 'POST committee',
    title: 'Call the investment committee',
    description:
      "As CIO or PM, puts a question (usually a proposal) to the desks: each seat casts a sealed BUY / HOLD / SELL ballot, the Skeptic always among them, then the ballots open and you decide with fund_decide. Seats default to every staffed desk. A proposal over the fund's committee threshold needs a decision before you can rule on it.",
    inputSchema: schema({
      question: str('What the committee is to decide.'),
      proposalId: ID,
      symbol: str('The asset, when it is not about one proposal.'),
      seats: { type: 'array', items: { type: 'string' }, description: 'Role ids to seat (the Skeptic is always added); every staffed desk when left out.' },
      minutes: num('How long voting stays open: 1 to 240, 15 by default.'),
    }),
    annotations: act,
  },
  {
    name: 'fund_committee_close',
    route: 'POST committee-close',
    title: 'Open the ballots now',
    description: "As the chair, closes a committee's vote early and opens the ballots, counting whoever has not voted as abstaining.",
    inputSchema: schema({ id: str('The committee, like C-3.') }, ['id']),
    annotations: act,
  },
  {
    name: 'fund_decide',
    route: 'POST decide',
    title: 'Decide a committee',
    description: "As a committee's chair, once its ballots are open: the committee's decision (BUY, HOLD or SELL) and a summary of what it found, the dissent and why. It goes on the record and to every seat. A committee advises: a trade still goes through risk and a person's approval.",
    inputSchema: schema({ id: str('The committee, like C-3.'), vote: { type: 'string', enum: ['BUY', 'HOLD', 'SELL'] }, summary: str('What the committee found, the dissent, and why you decide this way.') }, ['id', 'vote', 'summary']),
    annotations: act,
  },
  {
    name: 'fund_strategies',
    route: 'GET strategies',
    title: 'Quant lab strategies',
    description:
      "The quant lab's strategies: each one's stage (idea → research → backtest → validation → paper → approved, or retired), owner, universe, rules, latest backtest, whether it clears the validation bar, its signal while on paper and its record of paper trades. " +
      'Also the kinds of strategy the lab runs, with their params, and the validation bar. With an id, the whole strategy, the bar’s checks and its backtests.',
    inputSchema: schema({ id: str('A strategy, like S-2.'), stage: str('Only this stage: idea, research, backtest, validation, paper, approved or retired.') }),
    annotations: read,
  },
  {
    name: 'fund_backtests',
    route: 'GET backtests',
    title: 'Backtests',
    description:
      "The lab's backtests, newest first: the rules and universe tested, the period and costs, Sharpe, Sortino, CAGR, max drawdown, win rate, profit factor, turnover and exposure, in sample and out of sample, against buy-and-hold. " +
      'With an id, its equity curve, its trades and exactly which prices it ran on (source and hash).',
    inputSchema: schema({ id: str('A backtest, like B-7.'), strategyId: str('Only this strategy’s, like S-2.') }),
    annotations: read,
  },
  {
    name: 'fund_history',
    route: 'GET history',
    title: 'Price history',
    description: "Daily closes for one asset, oldest first, from the fund's sources (Coinbase, Yahoo Finance, or simulated in the mock market), with the source and a hash of the data: the same prices the lab's backtests run on.",
    inputSchema: schema({ symbol: str('Like BTC or SPY.'), years: num('How far back, 0.25 to 10 (1 by default).') }, ['symbol']),
    annotations: read,
  },
  {
    name: 'fund_backtest',
    route: 'POST backtest',
    title: 'Run a backtest',
    description:
      "Backtests a strategy's rules (strategyId), or rules given here, on daily closes with no look-ahead: positions are decided at each close and held to the next, costs (never less than the paper venue's fees and slippage) are charged on every change, assets are equally weighted, " +
      'and the last 30% of the period is held out of sample. It goes on the record. Kinds: trend {fast, slow}, momentum {lookback, threshold}, mean-reversion {window, entry, exit}, breakout {entry, exit}, buy-hold.',
    inputSchema: schema({
      strategyId: str('A registered strategy, like S-2: its rules and universe.'),
      kind: { type: 'string', enum: ['trend', 'momentum', 'mean-reversion', 'breakout', 'buy-hold'] },
      params: { type: 'object', additionalProperties: { type: 'number' }, description: 'The kind’s params; any left out take their defaults (fund_strategies lists them).' },
      universe: { type: 'array', items: { type: 'string' }, description: 'The symbols, like ["BTC","ETH"], equally weighted.' },
      short: { type: 'boolean', description: 'Let it go short where it would sell.' },
      volTargetPct: num('Size each position to this annualized volatility, in %.'),
      years: num('Years of history, 1 to 15 (5 by default).'),
      costBps: num('Costs per trade in basis points, when higher than the venue’s.'),
    }),
    annotations: act,
  },
  {
    name: 'fund_strategy',
    route: 'POST strategy',
    title: 'Register or edit a strategy',
    description:
      'Registers a strategy with the quant lab, where it starts as an idea, or edits one by its id (what you leave out stays as it was). Its rules may change until it goes on paper; changing them in validation sends it back to backtest. ' +
      'Its owner is the desk told when its signal changes.',
    inputSchema: schema({
      id: str('A strategy to edit, like S-2.'),
      name: str('What to call it.'),
      hypothesis: str('What it bets on, and why that should pay.'),
      universe: { type: 'array', items: { type: 'string' }, description: 'The symbols it trades, like ["BTC","ETH"].' },
      kind: { type: 'string', enum: ['trend', 'momentum', 'mean-reversion', 'breakout', 'buy-hold'] },
      params: { type: 'object', additionalProperties: { type: 'number' }, description: 'The kind’s params.' },
      short: { type: 'boolean', description: 'May it go short?' },
      volTargetPct: num('Size each position to this annualized volatility, in %.'),
      owner: str('The role that looks after it (yours by default), like quant or strategy.'),
    }),
    annotations: act,
  },
  {
    name: 'fund_strategy_stage',
    route: 'POST strategy-stage',
    title: 'Move a strategy',
    description:
      'Moves a strategy one step on, back to research, or to retired, when its gate allows. Backtest needs a backtest of its rules; validation, one over enough years; paper, a backtest of the current rules that clears the validation bar, moved by a desk that didn’t write it; ' +
      'approved, a person, after its days on paper. Its owner, the CIO or PM retires it.',
    inputSchema: schema({ id: str('The strategy, like S-2.'), stage: { type: 'string', enum: ['research', 'backtest', 'validation', 'paper', 'retired'] }, note: str('Why.') }, ['id', 'stage']),
    annotations: act,
  },
];

const BY_NAME = new Map(FUND_TOOLS.map((t) => [t.name, t]));

/** Whether `name` is one of the fund's tools. */
export const isFundTool = (name) => BY_NAME.has(name);

/**
 * One call to the fund on the office: resolves to what it answered, or throws with why it said no.
 * @param {string} route like 'GET portfolio'
 * @param {Record<string, unknown>} args
 * @param {{ env: Record<string, string | undefined>, fetch: typeof fetch }} io
 */
export async function fundCall(route, args, io) {
  const office = officeEnv(io.env);
  const [method, path] = route.split(' ');
  const url = new URL(`${office.url}/fund/${path}`);
  url.searchParams.set('worker', office.worker);
  const headers = { authorization: `Bearer ${office.token}` };
  let req;
  if (method === 'GET') {
    for (const [k, v] of Object.entries(args ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    req = { method, url: url.href, headers, timeout: TIMEOUT_MS };
  } else req = { method, url: url.href, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(args ?? {}), timeout: TIMEOUT_MS };
  const res = await send(req, io.fetch);
  if (res.status === 404 && !res.body?.error) throw new Error("The office doesn't know the fund's tools (404): it's running an older Agent Office than this command. Restart or upgrade it.");
  if (res.status < 200 || res.status >= 300) throw new Error(refusal(res.status, res.body));
  return res.body;
}

/**
 * The fund tools this worker's role may use, for the MCP server's list: none when it holds no fund
 * role (or isn't in an office that has a fund), so a coding agent's tool list stays its own.
 */
export async function fundToolsFor(io) {
  try {
    const me = await fundCall('GET me', {}, io);
    if (!me?.role || !Array.isArray(me.tools)) return [];
    return FUND_TOOLS.filter((t) => me.tools.includes(t.name)).map(({ route: _, ...t }) => t);
  } catch {
    return [];
  }
}

/** Runs a fund tool; resolves to its text, or throws with why it failed. */
export async function runFundTool(name, args, io) {
  const a = args && typeof args === 'object' ? args : {};
  // An idea of yours, proposed: the same tool, with its id.
  const route = name === 'fund_propose' && a.id ? 'POST promote' : BY_NAME.get(name)?.route;
  if (!route) throw new Error(`Unknown tool: ${name}`);
  return { text: JSON.stringify(await fundCall(route, a, io), null, 1) };
}

/** What the agent-office MCP server adds to its instructions about the fund. */
export const FUND_INSTRUCTIONS =
  " If you hold a desk at the office's paper-trading fund, its fund_* tools are how you read its book, market data and proposals, keep your memory (fund_thesis, fund_observe), " +
  'report your status, message the other desks, propose trades, vote on its investment committee (fund_ballot) and backtest strategies (fund_backtest); the office-fund command does the same from a shell. Its risk engine is code, and a person approves every trade.';

const USAGE = `Usage:
  office-fund <tool> ['<json>']      call one of the fund's tools, its arguments as JSON (or on stdin)
  office-fund tools                  the tools your desk may use
  office-fund help [tool]            this, or what one tool takes

Tools (fund_ is optional): ${FUND_TOOLS.map((t) => t.name.slice(5)).join(', ')}
For example:
  office-fund portfolio
  office-fund quotes '{"symbols":["BTC","NVDA"]}'
  office-fund status '{"status":"researching","note":"ETF flows"}'
  office-fund message '{"to":"cio","text":"Done: see my thesis"}'
  office-fund backtest '{"kind":"trend","params":{"fast":20,"slow":100},"universe":["BTC","ETH"]}'`;

function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (c) => (data += c));
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

/**
 * Runs the command; resolves to its exit code.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, stdin?: NodeJS.ReadableStream & { isTTY?: boolean }, fetch?: typeof fetch, out?: (s: string) => void, err?: (s: string) => void }} [io]
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdin = io.stdin ?? process.stdin;
  const ctx = { env, fetch: io.fetch ?? fetch };
  const out = io.out ?? ((s) => process.stdout.write(s + '\n'));
  const err = io.err ?? ((s) => process.stderr.write(s + '\n'));
  const [cmd = 'help', ...rest] = argv;
  const tool = (n) => BY_NAME.get(n) ?? BY_NAME.get(`fund_${n.replace(/-/g, '_')}`);
  try {
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
      const t = rest[0] && tool(rest[0]);
      out(t ? `${t.name}: ${t.description}\n\nTakes: ${JSON.stringify(t.inputSchema.properties, null, 1)}` : USAGE);
      return 0;
    }
    if (cmd === 'tools') {
      const me = await fundCall('GET me', {}, ctx);
      out(me.role ? `You're the ${me.role.title}. Your tools: ${me.tools.join(', ')}` : `You hold no desk at the fund, so you can only look: ${me.tools.join(', ')}`);
      return 0;
    }
    const t = tool(cmd);
    if (!t) {
      err(`office-fund: there's no tool called ${cmd}\n\n${USAGE}`);
      return 2;
    }
    const raw = rest.length ? rest.join(' ') : t.route.startsWith('POST') && !stdin.isTTY ? await readStdin(stdin) : '';
    let args = {};
    if (raw.trim()) {
      try {
        args = JSON.parse(raw);
      } catch {
        err(`office-fund: the arguments are JSON, like '{"symbol":"BTC"}'`);
        return 2;
      }
    }
    out((await runFundTool(t.name, args, ctx)).text);
    return 0;
  } catch (e) {
    err(`office-fund: ${e.message}`);
    return 1;
  }
}

const invoked = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
// No top-level await: office-workers.js imports this module, and must not wait on it.
if (invoked) void main(process.argv.slice(2)).then((code) => (process.exitCode = code));
