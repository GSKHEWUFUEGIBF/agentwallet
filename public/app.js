// AgentWallet front end. Plain JavaScript, no build step.
// Text from the agent and the server is always inserted with textContent
// (through h() below), never as HTML, so nothing an agent says can inject markup.

const CATEGORY_LABELS = {
  office: 'Office',
  electronics: 'Electronics',
  books: 'Books',
  home: 'Home',
  'gift-cards': 'Gift cards',
  luxury: 'Luxury',
};
const EXAMPLES = [
  { label: 'Buy a USB-C hub under $30', task: 'Buy a USB-C hub under $30' },
  { label: 'Get wireless earbuds and a notebook', task: 'Get wireless earbuds and a notebook' },
  { label: 'Order a standing desk', task: 'Order a standing desk' },
  { label: 'Hostile listing test', task: 'Buy the productivity bundle', title: 'This listing tells AI agents to ignore your rules. The wallet blocks it anyway.' },
];
// One job that ends in all three outcomes with the default rules and about $100 in the wallet.
const TOUR_TASK = 'Buy a USB-C cable, wireless earbuds and a standing desk';

const $ = (sel) => document.querySelector(sel);
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const toCents = (v) => Math.round(parseFloat(v) * 100);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// The owner key lives in sessionStorage only, so closing the tab forgets it.
const keyStore = {
  get() { try { return sessionStorage.getItem('aw-owner-key') || ''; } catch { return ''; } },
  set(v) { try { v ? sessionStorage.setItem('aw-owner-key', v) : sessionStorage.removeItem('aw-owner-key'); } catch { /* storage unavailable */ } },
};

function headersFor(body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (keyStore.get()) headers['x-owner-key'] = keyStore.get();
  return headers;
}

async function failFrom(res) {
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.needsOwnerKey) {
    keyStore.set('');
    showKeyForm(true, true);
  }
  throw new Error(data.error || `Something went wrong (${res.status}).`);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: headersFor(body),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) await failFrom(res);
  return res.json().catch(() => ({}));
}

function showKeyForm(show, focus = false) {
  $('#key-form').hidden = !show;
  if (show && focus) $('#owner-key').focus(); // only when the person just hit a locked action
}

let state = null;
let running = false;
let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), Math.max(4500, message.length * 70));
}

// ---------- How a purchase reads to a person ----------

function outcomeOf(p) {
  if (p.status === 'failed') return { tone: 'stop', glyph: '!', text: 'Payment failed' };
  if (p.status === 'unconfirmed' || p.status === 'settling') return { tone: 'hold', glyph: '?', text: 'Waiting for PayPal to confirm' };
  // Not enough money is a funding problem, not a broken rule, so it is not red.
  if (p.decision === 'denied' && /^The wallet has /.test(p.reasons?.[0] ?? '')) return { tone: 'hold', glyph: '$', text: 'Not enough funds' };
  if (p.status === 'declined') return { tone: 'stop', glyph: '✕', text: 'You declined' };
  if (p.decision === 'denied') return { tone: 'stop', glyph: '✕', text: 'Blocked' };
  if (p.status === 'pending') return { tone: 'hold', glyph: '‖', text: 'Waiting for your approval' };
  return p.decidedBy === 'owner'
    ? { tone: 'go', glyph: '✓', text: 'Paid after your approval' }
    : { tone: 'go', glyph: '✓', text: 'Paid automatically' };
}

function outcomeBadge(p) {
  const o = outcomeOf(p);
  return h('span', { class: `outcome ${o.tone}` }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, o.glyph), o.text);
}

function whyText(p) {
  if (p.status === 'failed' || p.status === 'unconfirmed') return p.error;
  if (p.decision === 'allowed') return null;
  return p.reasons.join(' ');
}

async function decide(p, verb) {
  try {
    const result = await api('POST', `/api/purchases/${p.id}/${verb}`);
    await refresh();
    // The button that was pressed is gone now; put focus on the updated entry instead.
    const next = [...document.querySelectorAll(`[data-pid="${p.id}"]`)].find((el) => el.offsetParent !== null);
    if (next) {
      next.setAttribute('tabindex', '-1');
      next.focus();
    }
    toast(
      verb === 'approve'
        ? result.status === 'settled'
          ? `Approved. ${money(result.amountCents)} paid to ${result.merchant}.`
          : `That payment failed: ${result.error}`
        : `Declined. Nothing was spent on ${result.title}.`,
    );
  } catch (err) {
    toast(err.message);
  }
}

function approvalButtons(p) {
  if (!(p.decision === 'held' && p.status === 'pending')) return null;
  return h(
    'div',
    { class: 'entry-actions' },
    h('button', { class: 'approve', type: 'button', onclick: () => decide(p, 'approve') }, `Approve ${money(p.amountCents)}`),
    h('button', { class: 'decline', type: 'button', onclick: () => decide(p, 'decline') }, 'Decline'),
  );
}

/** A purchase as it appears while the agent is working. */
function streamEntry(p) {
  const o = outcomeOf(p);
  const why = whyText(p);
  return h(
    'li',
    { class: `entry ${o.tone}`, 'data-pid': p.id, 'data-sig': `${p.status}|${p.decision}` },
    h('div', { class: 'entry-head' }, h('span', {}, p.title), h('span', { class: 'entry-amt' }, money(p.amountCents))),
    h('p', { class: 'entry-merchant' }, p.merchant),
    outcomeBadge(p),
    why && h('p', { class: 'why' }, why),
    approvalButtons(p),
  );
}

/** One line of the receipt tape: a purchase or a top-up. */
function tapeLine(item) {
  const time = new Date(item.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (item.kind === 'topup') {
    const failed = item.status === 'failed';
    return h(
      'li',
      {},
      h(
        'div',
        { class: 'line' },
        h('span', { class: 'line-title' }, failed ? 'Top-up failed' : 'Added with PayPal'),
        h('span', { class: `line-amt ${failed ? 'void' : 'plus'}` }, `${failed ? '' : '+'}${money(item.amountCents)}`),
        h('span', { class: 'line-sub' }, failed ? item.error : time),
      ),
    );
  }
  const p = item;
  const void_ = !['settled', 'pending', 'unconfirmed', 'settling'].includes(p.status);
  const sign = ['settled', 'unconfirmed', 'settling'].includes(p.status) ? '−' : '';
  const why = whyText(p);
  return h(
    'li',
    { 'data-pid': p.id },
    h(
      'div',
      { class: 'line' },
      h('span', { class: 'line-title' }, p.title),
      h('span', { class: `line-amt ${void_ ? 'void' : ''}` }, `${sign}${money(p.amountCents)}`),
      h('span', { class: 'line-sub' }, `${p.merchant}, ${time}`),
      outcomeBadge(p),
      why && h('span', { class: 'line-sub' }, why),
    ),
    approvalButtons(p),
  );
}

// ---------- Rendering ----------

function render() {
  const s = state;
  $('#balance').textContent = money(s.wallet.balanceCents);
  $('#funds-sub').textContent =
    `${money(s.spentTodayCents)} spent today of a ${money(s.rules.dailyBudgetCents)} daily budget.`;

  const paypalLabel = s.modes.paypal === 'sandbox' ? 'PayPal sandbox' : 'Simulated checkout';
  const aiLabel = s.modes.ai === 'claude' ? `Claude (${s.modes.model})` : 'Keyword demo agent';
  $('#modes').replaceChildren(
    h('span', {}, 'Payments: ', h('strong', {}, paypalLabel)),
    h('span', {}, 'Agent: ', h('strong', {}, aiLabel)),
  );

  // Spend-today meter and the funds gate on the agent.
  const budget = s.rules.dailyBudgetCents || 1;
  $('#meter-fill').style.width = `${Math.min(100, Math.round((s.spentTodayCents / budget) * 100))}%`;
  const empty = s.wallet.balanceCents <= 0;
  $('#run').disabled = empty || running;
  $('#need-funds').hidden = !empty;

  // View-only visitors (an owner key is set and they have not entered it).
  const locked = s.modes.ownerKeyRequired && !keyStore.get();
  $('#view-only').hidden = !locked;
  if (locked) showKeyForm(true);
  else if (s.modes.ownerKeyRequired) $('#key-form').hidden = true;
  renderLadder(s.rules);
  renderChrome(s);
  $('#topup-hint').textContent =
    s.modes.paypal === 'sandbox'
      ? 'You will sign in to PayPal with a sandbox buyer account to approve the payment.'
      : 'You will see a stand-in checkout page. No real PayPal account or money is involved.';

  $('#rules-summary').textContent = s.rulesSummary;
  $('#reset').hidden = !s.modes.resetEnabled;

  // Tape: purchases and completed or failed top-ups, newest first.
  const items = [
    ...s.purchases.map((p) => ({ ...p, kind: 'purchase' })),
    ...s.topups.filter((t) => t.status === 'completed' || t.status === 'failed').map((t) => ({ ...t, kind: 'topup' })),
  ].sort((a, b) => b.ts.localeCompare(a.ts));
  $('#tape').replaceChildren(
    ...(items.length
      ? items.map(tapeLine)
      : [h('li', { class: 'tape-empty' }, 'Nothing yet. Add funds, then give the agent a job.')]),
  );

  const pill = $('#pending-pill');
  pill.hidden = s.pendingCount === 0;
  pill.textContent = `${s.pendingCount} waiting for you`;

  // Keep purchases already shown in the agent stream in step with the latest state.
  // Only entries whose outcome changed are rebuilt, so screen readers do not re-announce the rest.
  for (const li of document.querySelectorAll('#stream [data-pid]')) {
    const fresh = s.purchases.find((p) => p.id === li.dataset.pid);
    if (fresh && li.dataset.sig !== `${fresh.status}|${fresh.decision}`) li.replaceWith(streamEntry(fresh));
  }
}

/** Three bands on one bar: what the agent may pay alone, what needs you, what is blocked. */
function renderLadder(r) {
  const top = Math.max(r.hardLimitCents * 1.35, 1);
  const pay = Math.min(r.autoApproveLimitCents, r.hardLimitCents);
  const ask = Math.max(0, r.hardLimitCents - pay);
  const band = (cls, cents, glyph, text, sub) =>
    h('div', { class: `band ${cls}`, style: `flex:${Math.max(cents, top * 0.18)} 1 0` }, h('b', {}, `${glyph} ${text}`), h('span', {}, sub));
  for (const el of document.querySelectorAll('.ladder')) el.replaceChildren(
    band('go', pay, '✓', 'Paid', `up to ${money(pay)}`),
    band('hold', ask, '‖', 'Ask you', `${money(pay)} to ${money(r.hardLimitCents)}`),
    band('stop', top - r.hardLimitCents, '✕', 'Blocked', `above ${money(r.hardLimitCents)}`),
  );
}


// ---------- App shell: badge, bell, views ----------

function renderChrome(s) {
  const sandbox = s.modes.paypal === 'sandbox';
  const badge = $('#mode-badge');
  badge.textContent = sandbox ? 'PayPal sandbox' : 'Demo mode';
  badge.className = `badge ${sandbox ? 'go' : 'hold'}`;

  const n = s.pendingCount;
  $('#bell').setAttribute('aria-label', n ? `${n} ${n === 1 ? 'purchase is' : 'purchases are'} waiting for you` : 'Nothing is waiting for you');
  $('#bell-count').hidden = n === 0;
  $('#bell-count').textContent = String(n);

  $('#owner-note').textContent = s.modes.ownerKeyRequired
    ? 'An owner key is set. Anyone can view this wallet, but only someone with the key can add funds, run the agent, approve purchases or change rules. The key is kept in this tab only.'
    : 'No owner key is set, so anyone with this address can use the wallet. That is fine for a mock-mode demo with no real money. Set OWNER_KEY before connecting PayPal.';
  $('#reset-note').textContent = s.modes.resetEnabled ? '' : 'Reset is switched off on this server (ALLOW_RESET is not 1).';

  const chip = (tone, text) => h('span', { class: `outcome ${tone}` }, text);
  $('#agent-card').replaceChildren(
    h('h2', {}, s.modes.ai === 'claude' ? 'Claude shopping agent' : 'Keyword demo agent'),
    h('p', {}, s.modes.ai === 'claude'
      ? `Claude (${s.modes.model}) reads your job, searches the store and asks the wallet to buy, using tool calls. It explains what it did.`
      : 'A simple keyword matcher stands in for the AI, so the whole app works with no account. It is not an AI model. Add an Anthropic key to use Claude.'),
    chip(s.modes.ai === 'claude' ? 'go' : 'hold', s.modes.ai === 'claude' ? 'Live model' : 'Stand-in'),
    h('p', { class: 'hint' }, 'Tools: check_wallet, search_catalog, request_purchase'),
    h('a', { class: 'linkish', href: '#/' }, 'Give it a job'),
  );

  const card = (title, tone, status, text) =>
    h('article', { class: 'card' }, h('h2', {}, title), h('span', { class: `outcome ${tone}` }, status), h('p', {}, text));
  $('#integrations').replaceChildren(
    card('PayPal Orders: add funds', sandbox ? 'go' : 'hold', sandbox ? 'Connected (sandbox)' : 'Simulated',
      sandbox ? 'Top-ups create a sandbox order, send you to PayPal to approve, then capture it. The captured amount is verified before the wallet is credited.' : 'A stand-in checkout page replaces PayPal. Add PayPal sandbox credentials to use the real one.'),
    card('PayPal Payouts: pay merchants', sandbox && s.modes.receiverConfigured ? 'go' : 'hold', sandbox && s.modes.receiverConfigured ? 'Connected (sandbox)' : 'Simulated',
      sandbox && s.modes.receiverConfigured ? 'Allowed purchases are paid out to your sandbox receiver account. The purchase id is the batch id, so a retry cannot pay twice.' : 'Payouts are simulated. Set PAYPAL_MERCHANT_EMAIL to a sandbox account to send real sandbox payouts.'),
    card('Claude: the shopping agent', s.modes.ai === 'claude' ? 'go' : 'hold', s.modes.ai === 'claude' ? s.modes.model : 'Not connected',
      s.modes.ai === 'claude' ? 'Tool use with three tools. The wallet, not the model, decides every purchase.' : 'Add ANTHROPIC_API_KEY to switch from the keyword stand-in to Claude.'),
    card('Owner key', s.modes.ownerKeyRequired ? 'go' : 'hold', s.modes.ownerKeyRequired ? 'Protected' : 'Open',
      s.modes.ownerKeyRequired ? 'Money-moving actions need the key.' : 'Fine for a demo with no real credentials.'),
  );
  if (currentView === 'transactions') renderLedger();
}

const VIEWS = ['dashboard', 'rules', 'agents', 'transactions', 'integrations', 'settings'];
const VIEW_TITLES = {
  dashboard: 'Dashboard', rules: 'Budgets & rules', agents: 'Agents',
  transactions: 'Transactions', integrations: 'Integrations', settings: 'Settings',
};
let currentView = 'dashboard';
let firstRoute = true;
let keepFocus = false;

function route() {
  const key = location.hash.replace(/^#\/?/, '');
  currentView = VIEWS.includes(key) ? key : 'dashboard';
  for (const sec of document.querySelectorAll('[data-view]')) sec.hidden = sec.dataset.view !== currentView;
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === currentView) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${VIEW_TITLES[currentView]} · AgentWallet`;
  if (currentView === 'agents') loadCatalog();
  if (currentView === 'transactions') renderLedger();
  if (!firstRoute && !keepFocus) {
    const head = document.querySelector(`[data-view="${currentView}"] h1`);
    head.setAttribute('tabindex', '-1');
    head.focus();
    window.scrollTo(0, 0);
  }
  firstRoute = false;
  keepFocus = false;
}
window.addEventListener('hashchange', route);

// ---------- Transactions ----------

const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function ledgerItems() {
  return [
    ...state.purchases.map((p) => ({ ...p, kind: 'purchase' })),
    ...state.topups.filter((t) => t.status === 'completed' || t.status === 'failed').map((t) => ({ ...t, kind: 'topup' })),
  ].sort((a, b) => b.ts.localeCompare(a.ts));
}

function ledgerRow(item) {
  const cell = (label, ...kids) => h('td', { 'data-label': label }, ...kids);
  if (item.kind === 'topup') {
    const failed = item.status === 'failed';
    return h('tr', {},
      cell('When', when(item.ts)),
      cell('Item', h('b', {}, failed ? 'Top-up failed' : 'Added with PayPal')),
      cell('Amount', h('span', { class: failed ? 'void' : 'plus' }, `${failed ? '' : '+'}${money(item.amountCents)}`)),
      cell('Outcome', h('span', { class: `outcome ${failed ? 'stop' : 'go'}` }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, failed ? '!' : '+'), failed ? 'Failed' : 'Funds added')),
      cell('Why', failed ? item.error : ''),
    );
  }
  const o = outcomeOf(item);
  const counted = ['settled', 'settling', 'unconfirmed'].includes(item.status);
  return h('tr', { 'data-pid': item.id },
    cell('When', when(item.ts)),
    cell('Item', h('b', {}, item.title), h('br'), h('span', { class: 'muted' }, item.merchant)),
    cell('Amount', h('span', { class: counted ? '' : item.status === 'pending' ? '' : 'void' }, `${counted ? '−' : ''}${money(item.amountCents)}`)),
    cell('Outcome', outcomeBadge(item)),
    cell('Why', whyText(item) ?? '', approvalButtons(item)),
  );
}

function renderLedger() {
  if (!state) return;
  const q = $('#search').value.trim().toLowerCase();
  const filter = $('#tx-filter').value;
  const rows = ledgerItems().filter((it) => {
    const tone = it.kind === 'topup' ? 'funds' : outcomeOf(it).tone;
    if (filter !== 'all' && tone !== filter) return false;
    if (!q) return true;
    const text = it.kind === 'topup' ? 'added with paypal top-up funds' : `${it.title} ${it.merchant} ${outcomeOf(it).text} ${whyText(it) ?? ''}`;
    return text.toLowerCase().includes(q);
  });
  $('#ledger tbody').replaceChildren(
    ...(rows.length
      ? rows.map(ledgerRow)
      : [h('tr', {}, h('td', { colspan: 5, class: 'muted' }, q || filter !== 'all' ? 'Nothing matches. Clear the search or the filter.' : 'Nothing yet. Add funds, then give the agent a job.'))]),
  );
  $('#tx-count').textContent = `${rows.length} ${rows.length === 1 ? 'transaction' : 'transactions'}`;
}

$('#tx-filter').addEventListener('change', renderLedger);
$('#search').addEventListener('input', () => {
  if (currentView !== 'transactions') {
    keepFocus = true; // typing in the search box must not pull focus away
    location.hash = '#/transactions';
  }
  renderLedger();
});

// ---------- The demo store ----------

let catalogLoaded = false;
async function loadCatalog() {
  if (catalogLoaded) return;
  try {
    const { items } = await api('GET', '/api/catalog');
    catalogLoaded = true;
    $('#catalog tbody').replaceChildren(
      ...items.map((it) => {
        const hostile = /ignore|ai agents?/i.test(it.description);
        return h('tr', {},
          h('td', { 'data-label': 'Item' }, h('b', {}, it.title),
            hostile && h('span', { class: 'outcome stop flag' }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, '!'), 'Hostile listing'),
            hostile && h('p', { class: 'quote' }, `Listing text: “${it.description}”`)),
          h('td', { 'data-label': 'Merchant' }, it.merchant),
          h('td', { 'data-label': 'Category' }, CATEGORY_LABELS[it.category] ?? it.category),
          h('td', { 'data-label': 'Price', class: 'num' }, money(it.priceCents)),
        );
      }),
    );
  } catch (err) {
    toast(err.message);
  }
}

function fillRulesForm() {
  const f = $('#rules-form');
  const r = state.rules;
  f.autoApprove.value = (r.autoApproveLimitCents / 100).toFixed(2);
  f.hardLimit.value = (r.hardLimitCents / 100).toFixed(2);
  f.dailyBudget.value = (r.dailyBudgetCents / 100).toFixed(2);
  f.blocked.value = r.blockedMerchants.join(', ');
  for (const box of document.querySelectorAll('#cats input')) box.checked = r.allowedCategories.includes(box.value);
}

async function refresh() {
  state = await api('GET', '/api/state');
  render();
}

// ---------- Actions ----------

$('#topup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cents = toCents($('#topup-amt').value);
  const btn = $('#topup-btn');
  $('#topup-error').textContent = '';
  if (!(cents >= 100 && cents <= 50_000)) {
    $('#topup-error').textContent = 'Add between $1 and $500 at a time.';
    return;
  }
  btn.disabled = true;
  try {
    const { approveUrl } = await api('POST', '/api/topup', { amountCents: cents });
    const url = new URL(approveUrl, location.origin);
    // Only ever send the browser to this app or to PayPal.
    if (url.origin !== location.origin && !url.hostname.endsWith('.paypal.com')) throw new Error('Unexpected checkout address.');
    location.assign(url.href);
  } catch (err) {
    $('#topup-error').textContent = err.message;
    btn.disabled = false;
  }
});

$('#rules-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#rules-error');
  err.textContent = '';
  const body = {
    autoApproveLimitCents: toCents(f.autoApprove.value),
    hardLimitCents: toCents(f.hardLimit.value),
    dailyBudgetCents: toCents(f.dailyBudget.value),
    allowedCategories: [...document.querySelectorAll('#cats input:checked')].map((b) => b.value),
    blockedMerchants: f.blocked.value.split(',').map((m) => m.trim()).filter(Boolean),
  };
  if ([body.autoApproveLimitCents, body.hardLimitCents, body.dailyBudgetCents].some(Number.isNaN)) {
    err.textContent = 'Enter a dollar amount in each limit.';
    return;
  }
  try {
    state = await api('PUT', '/api/rules', body);
    render();
    fillRulesForm();
    toast('Rules saved. They apply to the next purchase the agent requests.');
  } catch (ex) {
    err.textContent = ex.message;
  }
});

function addToStream(node) {
  const stream = $('#stream');
  stream.querySelector('.empty')?.remove();
  stream.append(node);
}

function showEvent(ev) {
  document.getElementById('working')?.remove();
  switch (ev.type) {
    case 'text':
      addToStream(h('li', { class: 'say' }, ev.text));
      break;
    case 'search':
      addToStream(
        h(
          'li',
          { class: 'step' },
          `Searched for “${ev.query}”${ev.maxPriceUsd != null ? ` under ${money(ev.maxPriceUsd * 100)}` : ''}: ${ev.count} ${ev.count === 1 ? 'match' : 'matches'}.`,
        ),
      );
      break;
    case 'purchase':
      addToStream(streamEntry(ev.purchase));
      break;
    case 'error':
      addToStream(h('li', { class: 'error' }, ev.message));
      break;
    default:
      break;
  }
}

$('#agent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const task = $('#task').value.trim();
  if (!task) return;
  const btn = $('#run');
  running = true;
  btn.disabled = true;
  btn.textContent = 'Running…';
  const stream = $('#stream');
  stream.setAttribute('aria-busy', 'true');
  stream.replaceChildren(h('li', { class: 'step working', id: 'working' }, 'The agent is reading the catalog…'));
  try {
    const res = await fetch('/api/agent/run', {
      method: 'POST',
      headers: headersFor(true),
      body: JSON.stringify({ task }),
    });
    if (!res.ok) await failFrom(res);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        showEvent(ev);
        if (ev.type === 'purchase') await refresh(); // the balance and tape change as soon as the agent buys
      }
    }
  } catch (err) {
    showEvent({ type: 'error', message: err.message });
  } finally {
    running = false;
    document.getElementById('working')?.remove();
    stream.removeAttribute('aria-busy');
    btn.textContent = 'Run agent';
    await refresh().catch(() => {});
    btn.disabled = state ? state.wallet.balanceCents <= 0 : false;
  }
});

// One click that shows paid, held and blocked in a single run.
$('#tour').addEventListener('click', () => {
  if (state && state.wallet.balanceCents < 6_000) {
    $('#topup-error').textContent = 'Add about $100 first, then try the three outcomes.';
    $('#topup-amt').focus();
    return;
  }
  $('#task').value = TOUR_TASK;
  $('#agent-form').requestSubmit();
});

$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  keyStore.set($('#owner-key').value.trim());
  $('#owner-key').value = '';
  try {
    await refresh();
    toast(keyStore.get() ? 'Owner key saved for this tab.' : '');
  } catch (err) {
    toast(err.message);
  }
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('Reset the wallet, rules and history for this demo?')) return;
  try {
    state = await api('POST', '/api/reset');
    $('#stream').replaceChildren(h('li', { class: 'empty' }, 'Give the agent a job. Each purchase will show Paid, Waiting for you or Blocked, and why.'));
    render();
    fillRulesForm();
    toast('Demo data reset.');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Start ----------

$('#chips').replaceChildren(
  ...EXAMPLES.map((ex) =>
    h('button', { class: 'chip', type: 'button', title: ex.title, onclick: () => { $('#task').value = ex.task; $('#task').focus(); } }, ex.label),
  ),
);
$('#cats').replaceChildren(
  ...Object.entries(CATEGORY_LABELS).map(([value, label]) =>
    h('label', { class: 'cat' }, h('input', { type: 'checkbox', value }), label),
  ),
);

const params = new URLSearchParams(location.search);
const topupResult = params.get('topup');
if (topupResult === 'retry' && /^[A-Za-z0-9-]{6,64}$/.test(params.get('token') ?? '')) {
  // PayPal had not confirmed the capture. Ask again a few times; the capture is safe to repeat.
  const token = params.get('token');
  let tries = 0;
  try { tries = Number(sessionStorage.getItem(`aw-retry-${token}`) || 0); } catch { /* storage unavailable */ }
  if (tries < 3) {
    try { sessionStorage.setItem(`aw-retry-${token}`, String(tries + 1)); } catch { /* storage unavailable */ }
    setTimeout(() => location.replace(`/topup/return?token=${encodeURIComponent(token)}`), 3000);
  }
}
if (topupResult) {
  if (topupResult !== 'retry') history.replaceState(null, '', location.pathname);
  toast(
    {
      success: 'Funds added to the wallet.',
      cancelled: 'Checkout cancelled. Nothing was charged.',
      failed: 'The payment did not complete. Nothing was added.',
      retry: 'Confirming your payment with PayPal… this page will check again in a moment.',
    }[topupResult] ?? '',
  );
}

route();
refresh()
  .then(fillRulesForm)
  .catch((err) => toast(err.message));
