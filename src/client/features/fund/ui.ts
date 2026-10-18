// The 💼 Fund window: a trading terminal over the office. A ticker along the top (NAV, the day, the
// drawdown, the market data), then a tab each for the portfolio and its P&L, the agents at the desks, their research,
// proposals, the committee, the quant lab's strategies and backtests, risk, market, activity and settings. It watches the fund while it's open and lets go when it closes.
import './ui.css';
import type { ClientMsg } from '../../../shared/protocol';
import { pct, usd } from '../../../shared/fund/format';
import { store } from '../../state';
import { h, openModal, type Modal } from '../../ui/dom';
import { activityTab } from './activity';
import { agentsTab } from './agents';
import { backtestsTab } from './backtests';
import { committeeTab } from './committee';
import { marketTab } from './market';
import { overviewTab } from './overview';
import { proposalsTab } from './proposals';
import { researchTab } from './research';
import { riskTab } from './risk';
import { settingsTab } from './settings';
import { strategiesTab } from './strategies';
import { change, money, TABS, type FundTab, type TabDeps, type TabId } from './view';

/** The tab you had open last, for the next time the window opens. */
let lastTab: TabId = 'overview';

export function openFund(send: (msg: ClientMsg) => void, onClose: () => void): Modal {
  const title = h('h2', {}, '💼 Fund');
  const badges = h('div.fd-badges');
  const ticker = h('div.fd-ticker');
  const tabBar = h('nav.fd-tabs', { role: 'tablist' });
  const banners = h('div.fd-banners');
  const body = h('div.fd-body', {}, h('div.fd-empty.fd-loading', {}, 'Opening the fund…'));
  const el = h(
    'div.modal.fund',
    { role: 'dialog', 'aria-label': 'Fund' },
    h('header', {}, title, badges),
    ticker,
    tabBar,
    banners,
    body,
    h('footer', {}, h('span.grow', {}, 'Paper trading only. Risk is checked by code, never by a model, and only a person approves a trade. Every action is on the record.')),
  );

  const deps: TabDeps = { send, admin: () => store.me.admin, go: (id) => show(id) };
  const made = new Map<TabId, FundTab>();
  const makers: Record<TabId, () => FundTab> = {
    overview: () => overviewTab(deps),
    agents: () => agentsTab(deps),
    research: () => researchTab(deps),
    committee: () => committeeTab(deps),
    proposals: () => proposalsTab(deps),
    strategies: () => strategiesTab(deps),
    backtests: () => backtestsTab(deps),
    risk: () => riskTab(deps),
    market: () => marketTab(),
    activity: () => activityTab(),
    settings: () => settingsTab(deps),
  };
  let current: TabId = lastTab;

  function show(id: TabId) {
    // A tab you turn to starts at its top; the body scrolls for all of them.
    if (id !== current) body.scrollTop = 0;
    current = lastTab = id;
    for (const b of tabBar.querySelectorAll<HTMLElement>('button')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
    render();
  }

  tabBar.append(
    ...TABS.map((t, i) => h('button', { type: 'button', role: 'tab', 'data-tab': t.id, title: i < 10 ? `${t.label} (${(i + 1) % 10})` : t.label, onclick: () => show(t.id) }, i < 10 ? h('span.fd-key', {}, String((i + 1) % 10)) : null, t.label, h('span.fd-count'))),
  );

  function render() {
    const s = store.fund;
    if (!s) return;
    const p = s.portfolio;
    title.textContent = `💼 ${s.config.name}`;
    badges.replaceChildren(
      h('span.fd-badge.paper', { title: `Venue: ${s.venue}. This version never trades real money.` }, 'PAPER'),
      ...(s.market.mode === 'mock' ? [h('span.fd-badge.mock', { title: 'Simulated prices and signals: nothing here is the real market' }, 'MOCK MARKET')] : []),
      ...(s.halted ? [h('span.fd-badge.halted', {}, 'HALTED')] : []),
    );
    ticker.replaceChildren(
      h('span', {}, h('i', {}, 'NAV '), h('b.num', {}, usd(p.nav))),
      h('span', {}, h('i', {}, 'DAY '), money(p.dayPnl), ' ', change(p.dayPnlPct)),
      h('span', {}, h('i', {}, 'TOTAL '), change(p.totalPnlPct)),
      h('span', {}, h('i', {}, 'DD '), h('b.num', {}, pct(p.drawdownPct))),
      h('span', {}, h('i', {}, 'LEV '), h('b.num', {}, `${p.leverage.toFixed(2)}×`)),
      h('span.grow'),
      h('span', { class: `fd-feed ${s.market.polling ? 'live' : 'idle'}`, title: s.market.polling ? 'Prices are coming in' : 'Not asking for prices: nobody is looking and the fund holds nothing' }, h('i.dot'), s.market.mode === 'mock' ? 'MOCK DATA' : s.market.polling ? 'LIVE DATA' : 'DATA IDLE'),
    );
    banners.replaceChildren(
      s.halted ? h('div.fd-banner.bad', {}, s.halted, store.me.admin ? h('button.fd-btn.danger', { type: 'button', onclick: () => show('settings') }, 'Start over…') : null) : '',
      ...s.notes.map((n) => h('div.fd-banner.warn', {}, n)),
    );
    const awaiting = s.proposals.filter((x) => x.stage === 'user_approval').length;
    const count = tabBar.querySelector<HTMLElement>('[data-tab="proposals"] .fd-count');
    if (count) count.textContent = awaiting ? String(awaiting) : '';
    // Desks whose agent is waiting on a person (a question, a permission).
    const asking = s.desks.desks.filter((d) => d.process === 'needs_input').length;
    const deskCount = tabBar.querySelector<HTMLElement>('[data-tab="agents"] .fd-count');
    if (deskCount) deskCount.textContent = asking ? String(asking) : '';
    // Committees whose ballots are open and wait on a person's decision.
    const deciding = s.committees.filter((c) => c.status === 'open' && !c.chair).length;
    const cmtCount = tabBar.querySelector<HTMLElement>('[data-tab="committee"] .fd-count');
    if (cmtCount) cmtCount.textContent = deciding ? String(deciding) : '';

    let tab = made.get(current);
    if (!tab) {
      tab = makers[current]();
      made.set(current, tab);
    }
    for (const [id, t] of made) t.el.classList.toggle('hidden', id !== current);
    if (!tab.el.isConnected) body.append(tab.el);
    body.querySelector('.fd-loading')?.remove();
    tab.update(s, store.fundActivity);
  }

  // 1–9 and 0 turn to the first ten tabs, unless you're typing.
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (e.ctrlKey || e.metaKey || e.altKey || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const i = e.key === '0' ? 9 : Number(e.key) - 1;
    if (Number.isInteger(i) && TABS[i]) show(TABS[i].id);
  };
  window.addEventListener('keydown', onKey);

  const offs = [store.on('fund', render), store.on('fundActivity', render), store.on('me', render)];
  send({ t: 'fund.watch', on: true });
  show(current);

  return openModal(el, {
    doing: 'at the fund',
    onClose: () => {
      for (const off of offs) off();
      window.removeEventListener('keydown', onKey);
      send({ t: 'fund.watch', on: false });
      onClose();
    },
  });
}
