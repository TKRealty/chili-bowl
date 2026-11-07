/* Chili Cook-Off — client app. Vanilla JS, hash-routed, no build step. */

const API = 'https://xtymrzybmafvtbnvwiov.supabase.co/functions/v1/api';

/* Anonymous per-phone id, kept on the device so one phone = one ballot. */
function store(kind) {
  try {
    const s = window[kind];
    s.setItem('__t', '1');
    s.removeItem('__t');
    return s;
  } catch (_) {
    return null;
  }
}
const LS = store('localStorage');
function deviceId() {
  let id = LS && LS.getItem('chili_device');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
    if (LS) LS.setItem('chili_device', id);
  }
  return id;
}
const DEVICE_ID = deviceId();

const CATS = [
  { key: 'flavor', label: 'Flavor', hint: 'Depth, balance, does it taste finished?', low: 'Flat', high: 'Unforgettable' },
  { key: 'heat', label: 'Heat', hint: 'Is the spice level well judged for this chili?', low: 'No kick', high: 'Perfect burn' },
  { key: 'texture', label: 'Texture', hint: 'Body, meat, beans, thickness of the base.', low: 'Watery', high: 'Ideal body' },
  { key: 'aroma', label: 'Aroma', hint: 'What it promises before the first bite.', low: 'Faint', high: 'Intoxicating' },
];
const CAT_LABEL = Object.fromEntries(CATS.map((c) => [c.key, c.label]));

/* ------------------------------------------------------------ net */
let orgToken = (LS && LS.getItem('chili_org')) || null;
function setOrgToken(t) {
  orgToken = t;
  if (LS) t ? LS.setItem('chili_org', t) : LS.removeItem('chili_org');
}
async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': DEVICE_ID,
      ...(orgToken ? { 'X-Organizer-Token': orgToken } : {}),
      ...(opts.headers || {}),
    },
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = {};
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

/* ------------------------------------------------------------ state */
let S = null;
let draft = {};
let pendingEntry = null;
let refreshTimer = null;

async function loadState() {
  S = await api('/api/state');
  document.getElementById('brandName').textContent = S.event.name;
  document.getElementById('brandSub').textContent = S.event.subtitle || 'Voting HQ';
  document.title = `${S.event.name} — Voting & Awards`;
  return S;
}

/* ------------------------------------------------------------ helpers */
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = (v) => Number(v).toFixed(1);
const n2 = (v) => Number(v).toFixed(2);

function toast(msg, kind = '') {
  const host = document.getElementById('toasts');
  const t = el(`<div class="toast ${kind}">${esc(msg)}</div>`).firstElementChild;
  host.append(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

function qrSvg(text, size = 1000) {
  try {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 8, margin: 8, scalable: true });
  } catch (e) {
    return `<div class="faint center">QR could not render.<br />Use the link below.</div>`;
  }
}

// Always point QR codes and share links at the published event site,
// no matter where the organizer opened the dashboard from.
const LIVE_SITE = 'https://tkrealty.github.io/chili-bowl/';
function voteUrl(entryId) {
  const base = LIVE_SITE;
  return entryId ? `${base}#/vote/${entryId}` : `${base}#/vote`;
}
function boardUrl() {
  return `${LIVE_SITE}#/results`;
}

/* ------------------------------------------------------------ router */
const routes = {};
function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [name, ...rest] = raw.split('/');
  return { name: routes[name] ? name : 'dashboard', params: rest };
}

async function render() {
  const { name, params } = currentRoute();
  document.querySelectorAll('#tabs .tab').forEach((a) => {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const view = document.getElementById('view');
  if (!S) {
    try {
      await loadState();
    } catch (e) {
      view.replaceChildren(
        el(`<div class="notice notice-err">Can't reach the scoring server. ${esc(e.message)}</div>`)
      );
      return;
    }
  }
  view.replaceChildren(viewFor(name, params));
  window.scrollTo({ top: 0 });
  // live polling only on screens that show tallies
  clearInterval(refreshTimer);
  if (name === 'dashboard' || name === 'results') {
    refreshTimer = setInterval(async () => {
      try {
        await loadState();
        const cur = currentRoute();
        if (cur.name === name) document.getElementById('view').replaceChildren(viewFor(name, cur.params));
      } catch (_) {}
    }, 8000);
  }
}

async function reload() {
  await loadState();
  const { name, params } = currentRoute();
  document.getElementById('view').replaceChildren(viewFor(name, params));
}

/* ------------------------------------------------------------ organizer gate */
const ORGANIZER_ROUTES = new Set(['dashboard', 'entries', 'scorecards']);
const isOrg = () => Boolean(S && S.me && S.me.is_organizer);

function viewFor(name, params) {
  document.body.classList.toggle('is-organizer', isOrg());
  if (ORGANIZER_ROUTES.has(name) && !isOrg()) return organizerGate();
  return routes[name](params);
}

function organizerGate() {
  const frag = el(`
    <div class="gate stack">
      <div>
        <div class="eyebrow">Organizer only</div>
        <h1>Here to vote?</h1>
        <p class="lede">Tasters don't need a passcode. Tap below to pick your top 3.</p>
      </div>
      <a class="btn btn-primary btn-block" href="#/vote">Taste &amp; vote</a>
      <form class="card stack" id="gateForm" autocomplete="off">
        <h3>Organizer sign-in</h3>
        <label class="field"><span>Passcode</span>
          <input type="password" id="gateCode" inputmode="text" autocomplete="current-password" required />
        </label>
        <button class="btn btn-block" type="submit">Unlock dashboard</button>
        <p class="faint" id="gateMsg" role="status"></p>
      </form>
    </div>`);
  frag.getElementById('gateForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('gateMsg');
    const btn = ev.currentTarget.querySelector('button');
    btn.disabled = true;
    msg.textContent = '';
    try {
      const r = await api('/api/organizer/login', {
        method: 'POST',
        body: JSON.stringify({ passcode: document.getElementById('gateCode').value }),
      });
      setOrgToken(r.token);
      toast('Organizer tools unlocked.', 'ok');
      await reload();
    } catch (e) {
      msg.textContent = e.message;
      btn.disabled = false;
    }
  });
  return frag;
}

/* ============================================================ DASHBOARD */
/* ============================================================ helpers for ranked voting */
const PLACES = ['1st', '2nd', '3rd'];
const PLACE_PTS = [3, 2, 1];
const needed = () => Math.min(3, S.entries.length);
const entryById = (id) => S.entries.find((e) => e.id === id);
let picksDraft = []; // entry ids in order 1st, 2nd, 3rd

/* armed-button confirm: works where browser pop-ups are blocked */
function armConfirm(btn, label, action) {
  const original = btn.textContent;
  let armed = false;
  let timer = null;
  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.textContent = label;
      btn.classList.add('is-armed');
      timer = setTimeout(() => {
        armed = false;
        btn.textContent = original;
        btn.classList.remove('is-armed');
      }, 4000);
      return;
    }
    clearTimeout(timer);
    btn.disabled = true;
    btn.textContent = 'Working…';
    try {
      await action();
    } catch (e) {
      toast(e.message, 'bad');
      btn.disabled = false;
      btn.textContent = original;
      btn.classList.remove('is-armed');
      armed = false;
    }
  });
}

/* ============================================================ DASHBOARD */
routes.dashboard = () => {
  const r = S.results;
  const st = r.stats;
  const leader = r.winners && r.winners.length ? r.winners.map((w) => `#${w.number} ${w.name}`).join(' & ') : '—';
  const frag = el(`
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Organizer control room</div>
          <h1>${esc(S.event.name)}</h1>
          <p class="lede">Crowd vote: every guest ranks their top 3. 1st = 3 pts, 2nd = 2 pts, 3rd = 1 pt. One ballot per phone.</p>
        </div>
        <div class="row">
          <span class="badge ${S.event.voting_open ? 'badge-live' : ''}">${S.event.voting_open ? 'Voting open' : 'Voting closed'}</span>
          <button class="btn btn-sm" id="toggleVoting">${S.event.voting_open ? 'Close voting' : 'Open voting'}</button>
        </div>
      </div>

      <div class="grid g4">
        ${kpi('Ballots in', st.ballots, 'one per phone')}
        ${kpi('Chilis', st.entries, `${st.entries_with_votes} have votes`)}
        ${kpi('Points handed out', st.ballots * PLACE_PTS.slice(0, needed()).reduce((a, b) => a + b, 0), '3 + 2 + 1 per ballot')}
        ${kpi('Current leader', leader, r.winners && r.winners[0] ? `${r.winners[0].points} pts` : 'awaiting ballots')}
      </div>

      <section class="card stack">
        <div class="row spread">
          <h2>Live leaderboard</h2>
          <span class="faint">Ties: most 1st-place votes, then 2nd, then 3rd</span>
        </div>
        <div id="board"></div>
      </section>

      <div class="grid g2">
        <section class="card stack">
          <h2>Voting QR code</h2>
          <p class="faint">One code for the whole table. Guests scan, see every chili, and tap their 1st, 2nd and 3rd.</p>
          <div class="qr-frame" id="qrMain" style="max-width:260px;margin-inline:auto"></div>
          <div class="url-box">${esc(voteUrl())}</div>
          <div class="row">
            <button class="btn btn-sm" id="copyLink">Copy link</button>
            <a class="btn btn-sm" href="#/scorecards">Print QR poster</a>
          </div>
          <hr class="rule" />
          <h2>Leaderboard QR code</h2>
          <p class="faint">Opens the Awards screen. While winners are hidden, guests see the ballot count only. Tap Reveal winners to show standings, which update live.</p>
          <div class="qr-frame" id="qrBoard" style="max-width:260px;margin-inline:auto"></div>
          <div class="url-box">${esc(boardUrl())}</div>
          <div class="row">
            <button class="btn btn-sm" id="copyBoard">Copy link</button>
            <a class="btn btn-sm" href="#/scorecards">Print leaderboard poster</a>
          </div>
        </section>

        <section class="card stack">
          <h2>Awards ceremony</h2>
          <p class="faint">${S.event.results_locked ? 'Results are hidden from guests until you reveal them.' : 'The awards screen is live for everyone.'}</p>
          <div class="row">
            <button class="btn ${S.event.results_locked ? 'btn-primary' : ''}" id="toggleReveal">
              ${S.event.results_locked ? 'Reveal winners' : 'Hide winners again'}
            </button>
            <a class="btn btn-ghost" href="#/results">Open awards screen</a>
          </div>
          <hr class="rule" />
          <h3>Event details</h3>
          <label class="field"><span>Event name</span><input type="text" id="evName" value="${esc(S.event.name)}" /></label>
          <label class="field"><span>Subtitle</span><input type="text" id="evSub" value="${esc(S.event.subtitle)}" /></label>
          <div class="row"><button class="btn btn-sm" id="saveEvent">Save details</button></div>
          <hr class="rule" />
          <h3>Rehearse &amp; reset</h3>
          <div class="row">
            <button class="btn btn-sm" id="demoBtn">Load 40 test ballots</button>
            <button class="btn btn-sm" id="clearVotes">Clear all votes</button>
            <button class="btn btn-sm" id="exportBtn">Export CSV</button>
            <button class="btn btn-sm btn-danger" id="wipeAll">Start a fresh event</button>
          </div>
          <p class="faint"><strong>Clear all votes</strong> keeps your chilis. <strong>Start a fresh event</strong> removes every chili and every ballot. Both ask you to tap twice.</p>
          <hr class="rule" />
          <h3>Organizer passcode</h3>
          <label class="field"><span>Current passcode</span><input type="password" id="pcCur" autocomplete="current-password" /></label>
          <label class="field"><span>New passcode (4+ characters)</span><input type="password" id="pcNew" autocomplete="new-password" /></label>
          <div class="row">
            <button class="btn btn-sm" id="changeCode">Change passcode</button>
            <button class="btn btn-sm btn-ghost" id="signOut">Sign out of organizer tools</button>
          </div>
        </section>
      </div>
    </div>
  `);
  frag.getElementById('board').append(leaderboardTable(r));
  frag.getElementById('qrMain').innerHTML = qrSvg(voteUrl());
  frag.getElementById('qrBoard').innerHTML = qrSvg(boardUrl());
  queueMicrotask(() => wireDashboard());
  return frag;
};

function kpi(label, value, hint) {
  return `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value${String(value).length > 8 ? ' kpi-text' : ''}">${esc(value)}</div><div class="kpi-hint">${esc(hint)}</div></div>`;
}

function leaderboardTable(r) {
  if (!r.standings.length) {
    const msg = S.entries.length
      ? 'No ballots yet. Put the QR code out and the leaderboard fills in live.'
      : 'No chilis yet. Add your lineup on the Entries tab.';
    return el(`<div class="empty">${msg}</div>`);
  }
  const rows = r.standings
    .map(
      (s) => `<tr class="${s.rank === 1 ? 'is-first' : ''}">
        <td><span class="rank-pill">${s.rank}</span></td>
        <td class="entry-cell"><strong>#${s.number} ${esc(s.name)}</strong><small>${esc(s.cook || '—')}${s.co_placed ? ' · tied' : ''}${s.tie_broken_by && !s.co_placed ? ` · tie settled by ${esc(s.tie_broken_by)}` : ''}</small></td>
        <td><div class="row" style="gap:var(--space-3);flex-wrap:nowrap"><div class="bar"><i style="width:${s.share}%"></i></div><strong style="font-variant-numeric:tabular-nums">${s.points}</strong></div></td>
        <td class="num">${s.firsts}</td>
        <td class="num hide-sm">${s.seconds}</td>
        <td class="num hide-sm">${s.thirds}</td>
      </tr>`
    )
    .join('');
  const unscored = r.unscored.length
    ? `<p class="faint" style="margin-top:var(--space-3)">No votes yet: ${r.unscored.map((u) => `#${u.number} ${esc(u.name)}`).join(', ')}</p>`
    : '';
  return el(`<div>
    <div class="table-wrap"><table class="rank-table">
      <thead><tr><th>#</th><th>Chili</th><th>Points</th><th class="num">1st</th><th class="num hide-sm">2nd</th><th class="num hide-sm">3rd</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>${unscored}</div>`);
}

function wireDashboard() {
  const $ = (id) => document.getElementById(id);
  $('changeCode')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/organizer/passcode', {
        method: 'POST',
        body: JSON.stringify({ current: $('pcCur').value, new: $('pcNew').value }),
      });
      setOrgToken(r.token);
      toast('Passcode changed.', 'ok');
      $('pcCur').value = '';
      $('pcNew').value = '';
    } catch (e) {
      toast(e.status === 422 ? 'New passcode needs at least 4 characters.' : e.message, 'bad');
    }
  });
  $('signOut')?.addEventListener('click', async () => {
    await api('/api/organizer/logout', { method: 'POST', body: '{}' });
    setOrgToken(null);
    toast('Signed out of organizer tools.');
    await reload();
  });
  $('toggleVoting')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ voting_open: !S.event.voting_open }) });
    toast(S.event.voting_open ? 'Voting closed.' : 'Voting is open.', 'ok');
    await reload();
  });
  $('toggleReveal')?.addEventListener('click', async () => {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ results_locked: !S.event.results_locked }) });
    toast(S.event.results_locked ? 'Winners revealed.' : 'Winners hidden.', 'ok');
    await reload();
  });
  $('saveEvent')?.addEventListener('click', async () => {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ event_name: $('evName').value, event_subtitle: $('evSub').value }),
    });
    toast('Event details saved.', 'ok');
    await reload();
  });
  if ($('wipeAll'))
    armConfirm($('wipeAll'), 'Tap again: erase everything', async () => {
      await api('/api/reset', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
      toast('Fresh event. Add your chilis on the Entries tab.', 'ok');
      await reload();
    });
  if ($('clearVotes'))
    armConfirm($('clearVotes'), 'Tap again to clear votes', async () => {
      await api('/api/reset', { method: 'POST', body: JSON.stringify({ scope: 'votes' }) });
      toast('All votes cleared. Chilis kept.', 'ok');
      await reload();
    });
  $('demoBtn')?.addEventListener('click', async () => {
    try {
      await api('/api/reset', { method: 'POST', body: JSON.stringify({ scope: 'demo' }) });
      toast('40 test ballots loaded. Clear them before guests vote.', 'ok');
      await reload();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
  $('exportBtn')?.addEventListener('click', async () => {
    const { csv } = await api('/api/export.csv');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chili-bowl-results.csv';
    a.click();
    URL.revokeObjectURL(url);
    toast('CSV downloaded.', 'ok');
  });
  $('copyLink')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(voteUrl());
      toast('Voting link copied.', 'ok');
    } catch (_) {
      toast('Copy blocked — select the link text instead.');
    }
  });
  $('copyBoard')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(boardUrl());
      toast('Leaderboard link copied.', 'ok');
    } catch (_) {
      toast('Copy blocked — select the link text instead.');
    }
  });
}

/* ============================================================ VOTE */
routes.vote = () => {
  if (S.me.ballot) {
    const mine = S.me.ballot.filter(Boolean).map(entryById).filter(Boolean);
    return el(`<div class="vote-shell stack">
      <div><div class="eyebrow">${esc(S.event.name)}</div><h1>Your ballot is in</h1>
      <p class="lede">Thanks for tasting. Each phone gets one ballot, and yours is locked in.</p></div>
      <div class="card stack">
        ${mine.map((e, i) => `<div class="row" style="gap:var(--space-4)"><span class="place place-${i + 1}">${PLACES[i]}</span><strong>#${e.number} ${esc(e.name)}</strong></div>`).join('')}
      </div>
      <a class="btn btn-primary btn-block" href="#/results">Awards screen</a>
    </div>`);
  }
  if (!S.event.voting_open) {
    return el(`<div class="vote-shell stack">
      <div><div class="eyebrow">${esc(S.event.name)}</div><h1>Voting is closed</h1>
      <p class="lede">Ballots are counted. Stick around for the awards.</p></div>
      <a class="btn btn-primary btn-block" href="#/results">See the results</a>
    </div>`);
  }
  if (!S.entries.length) {
    return el(`<div class="vote-shell stack"><div><div class="eyebrow">${esc(S.event.name)}</div><h1>Almost time</h1>
      <p class="lede">The chili lineup isn't posted yet. Check back in a minute.</p></div></div>`);
  }

  picksDraft = picksDraft.filter((id) => entryById(id));
  const n = needed();
  const frag = el(`
    <div class="vote-shell stack">
      <div>
        <div class="eyebrow">${esc(S.event.name)}</div>
        <h1>Pick your top ${n}</h1>
        <p class="lede">Tap your favorite first, then your 2nd${n > 2 ? ', then your 3rd' : ''}. Tap again to undo.</p>
      </div>
      <div class="slots" id="slots"></div>
      <div class="entry-pick" id="picks"></div>
      <div class="sticky-submit"><button class="btn btn-primary btn-block" id="submitBallot" disabled></button></div>
      <p class="faint center">Anonymous. One ballot per phone.</p>
    </div>
  `);

  const paint = () => {
    const slots = document.getElementById('slots') || frag.getElementById('slots');
    slots.innerHTML = PLACES.slice(0, n)
      .map((p, i) => {
        const e = entryById(picksDraft[i]);
        return `<div class="slot ${e ? 'is-filled' : ''}"><span class="place place-${i + 1}">${p}</span><span class="slot-name">${e ? `#${e.number} ${esc(e.name)}` : 'Tap a chili'}</span></div>`;
      })
      .join('');
    (document.getElementById('picks') || frag.getElementById('picks')).querySelectorAll('.pick').forEach((b) => {
      const idx = picksDraft.indexOf(Number(b.dataset.entry));
      b.classList.toggle('is-picked', idx >= 0);
      const tag = b.querySelector('.pick-tag');
      tag.className = `pick-tag place ${idx >= 0 ? `place-${idx + 1}` : 'place-empty'}`;
      tag.textContent = idx >= 0 ? PLACES[idx] : 'Pick';
    });
    const sub = document.getElementById('submitBallot') || frag.getElementById('submitBallot');
    const left = n - picksDraft.length;
    sub.disabled = left > 0;
    sub.textContent = left > 0 ? `Pick ${left} more` : 'Submit my ballot';
  };

  const picks = frag.getElementById('picks');
  S.entries.forEach((e) => {
    const b = el(`<button class="pick" type="button" data-entry="${e.id}">
      <span class="pick-num">${e.number}</span>
      <span class="pick-body"><strong>${esc(e.name)}</strong>${e.heat_claim || e.description ? `<small>${esc([e.heat_claim, e.description].filter(Boolean).join(' · '))}</small>` : ''}</span>
      <span class="pick-tag place place-empty">Pick</span>
    </button>`).firstElementChild;
    b.addEventListener('click', () => {
      const idx = picksDraft.indexOf(e.id);
      if (idx >= 0) picksDraft.splice(idx, 1);
      else if (picksDraft.length < n) picksDraft.push(e.id);
      else return toast(`You already have your top ${n}. Tap one to swap it out.`);
      paint();
    });
    picks.append(b);
  });

  frag.getElementById('submitBallot').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await api('/api/ballot', {
        method: 'POST',
        body: JSON.stringify({ first: picksDraft[0], second: picksDraft[1] ?? null, third: picksDraft[2] ?? null }),
      });
      picksDraft = [];
      toast('Ballot counted. Thank you.', 'ok');
      await reload();
      window.scrollTo({ top: 0 });
    } catch (e) {
      toast(e.message, 'bad');
      if (e.data && e.data.already_voted) await reload();
      else paint();
    }
  });
  paint();
  return frag;
};

/* ============================================================ RESULTS */
routes.results = () => {
  const r = S.results;
  if (S.event.results_locked) {
    const b = r.stats.ballots;
    return el(`<div class="stack">
      <div class="stage">
        <div class="eyebrow">${esc(S.event.name)}</div>
        <h2>Winners announced shortly</h2>
        <p class="muted">${b} ${b === 1 ? 'ballot is' : 'ballots are'} in. The organizer reveals the results at the awards.</p>
      </div>
      ${isOrg() ? '<div class="center"><a class="btn btn-ghost no-print" href="#/dashboard">Organizer dashboard</a></div>' : '<div class="center"><a class="btn btn-primary no-print" href="#/vote">Back to my ballot</a></div>'}
    </div>`);
  }
  if (!r.standings.length) return el(`<div class="empty">No ballots have been turned in yet, so there is nothing to award.</div>`);

  const winners = r.winners;
  const champ = winners[0];
  const tieLine = winners.length > 1
    ? 'Dead even on points and on every tie-break. Co-champions.'
    : champ.tie_broken_by
      ? `Tied on points, won on ${esc(champ.tie_broken_by)}.`
      : '';
  const podium = r.standings.filter((s) => s.rank > 1 && s.rank <= 3);
  const frag = el(`
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Official results</div>
          <h1>${esc(S.event.name)}</h1>
          <p class="lede">${r.stats.ballots} ballots · 1st = 3 pts, 2nd = 2 pts, 3rd = 1 pt</p>
        </div>
        <div class="row no-print"><button class="btn btn-sm" onclick="window.print()">Print results</button></div>
      </div>

      <div class="stage">
        <span class="badge badge-ember">Crowd Champion${winners.length > 1 ? 's' : ''}</span>
        <h2>${winners.map((w) => `#${w.number} ${esc(w.name)}`).join(' &amp; ')}</h2>
        <p class="cook">${winners.map((w) => esc(w.cook || 'Cook unlisted')).join(' &amp; ')}</p>
        <p class="trophy-score">${champ.points} <span style="font-size:var(--text-sm);color:var(--muted)">points</span></p>
        <p class="faint">${champ.firsts} first-place · ${champ.seconds} second · ${champ.thirds} third</p>
        ${tieLine ? `<p class="tie-note" style="display:inline-block;text-align:left">${tieLine}</p>` : ''}
      </div>

      ${podium.length ? `<div class="grid g2">${podium.map((p) => `<section class="card stack">
          <span class="place place-${p.rank}" style="align-self:flex-start">${PLACES[p.rank - 1]} place${p.co_placed ? ' (tie)' : ''}</span>
          <h2 style="font-size:var(--text-xl)">#${p.number} ${esc(p.name)}</h2>
          <p class="muted">${esc(p.cook || 'Cook unlisted')} · ${p.points} pts</p>
          ${p.tie_broken_by && !p.co_placed ? `<p class="tie-note">Tie settled by ${esc(p.tie_broken_by)}.</p>` : ''}
        </section>`).join('')}</div>` : ''}

      <section class="card stack">
        <h2>Full standings</h2>
        <div id="finalBoard"></div>
        <details>
          <summary class="faint" style="cursor:pointer">How the votes are counted</summary>
          <ol class="faint" style="margin:var(--space-3) 0 0;padding-left:1.2rem;line-height:1.9">
            <li>Every guest ranks a top 3. 1st = 3 points, 2nd = 2, 3rd = 1.</li>
            <li>Most total points wins.</li>
            <li>Tied on points: most 1st-place votes wins, then most 2nds, then most 3rds.</li>
            <li>Still identical: co-winners.</li>
          </ol>
        </details>
      </section>
    </div>
  `);
  frag.getElementById('finalBoard').append(leaderboardTable(r));
  return frag;
};

/* ============================================================ ENTRIES */
routes.entries = () => {
  const frag = el(`
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Roster</div>
          <h1>Entries &amp; cooks</h1>
          <p class="lede">Numbers here should match the numbers on the pots. Guests see the number and chili name only, never the cook.</p>
        </div>
      </div>
      <div class="grid split-l">
        <section class="card stack">
          <h2>Current lineup (${S.entries.length})</h2>
          <div id="entryList" class="stack"></div>
        </section>
        <section class="card stack">
          <h2>Add an entry</h2>
          <label class="field"><span>Pot number</span><input type="number" id="eNum" min="1" placeholder="auto" /></label>
          <label class="field"><span>Chili name</span><input type="text" id="eName" placeholder="White Monster" /></label>
          <label class="field"><span>Cook</span><input type="text" id="eCook" placeholder="Travis K." /></label>
          <label class="field"><span>Declared heat</span><input type="text" id="eHeat" placeholder="Medium-hot" /></label>
          <label class="field"><span>Short description (optional, guests see this)</span><textarea id="eDesc" placeholder="Brisket, ancho, smoky finish"></textarea></label>
          <button class="btn btn-primary btn-block" id="addEntry">Add to lineup</button>
        </section>
      </div>
    </div>
  `);

  const list = frag.getElementById('entryList');
  if (!S.entries.length) list.append(el(`<div class="empty">No entries yet — add the first pot.</div>`));
  S.entries.forEach((e) => {
    const scored = S.results.standings.find((s) => s.entry_id === e.id);
    const row = el(`<div class="card" style="background:var(--surface-2)">
      <div class="row spread">
        <div class="row" style="gap:var(--space-4)">
          <span class="pick-num">${e.number}</span>
          <div>
            <strong>${esc(e.name)}</strong>
            <div class="faint">${esc(e.cook || 'Cook unlisted')}${e.heat_claim ? ` · ${esc(e.heat_claim)}` : ''} · ${scored ? `${scored.points} pts` : 'no votes yet'}</div>
          </div>
        </div>
        <div class="row">
          <button class="btn btn-sm" data-del="${e.id}">Remove</button>
        </div>
      </div>
    </div>`).firstElementChild;
    armConfirm(row.querySelector('[data-del]'), 'Tap again to remove', async () => {
      await api(`/api/entries/${e.id}`, { method: 'DELETE' });
      toast('Chili removed.', 'ok');
      await reload();
    });
    list.append(row);
  });

  frag.getElementById('addEntry').addEventListener('click', async (ev) => {
    const name = document.getElementById('eName').value.trim();
    if (!name) return toast('Give the chili a name.');
    ev.currentTarget.disabled = true;
    try {
      await api('/api/entries', {
        method: 'POST',
        body: JSON.stringify({
          number: document.getElementById('eNum').value ? Number(document.getElementById('eNum').value) : null,
          name,
          cook: document.getElementById('eCook').value,
          heat_claim: document.getElementById('eHeat').value,
          description: document.getElementById('eDesc').value,
        }),
      });
      toast('Entry added.', 'ok');
      await reload();
    } catch (e) {
      toast(e.message, 'bad');
      ev.currentTarget.disabled = false;
    }
  });
  return frag;
};

/* ============================================================ PRINT KIT */
routes.scorecards = () => {
  const frag = el(`
    <div class="stack">
      <div class="page-head no-print">
        <div>
          <div class="eyebrow">Print kit</div>
          <h1>QR poster &amp; paper ballots</h1>
          <p class="lede">One QR poster for the table, plus paper backup ballots for anyone without a phone.</p>
        </div>
        <button class="btn btn-primary" onclick="window.print()">Print this page</button>
      </div>

      <section class="sheet poster">
        <div class="poster-title">${esc(S.event.name)}</div>
        <div class="poster-ask">Scan to vote for your top 3</div>
        <div class="qr-frame poster-qr">${qrSvg(voteUrl())}</div>
        <div class="poster-steps">1. Scan with your camera &nbsp; 2. Tap your 1st, 2nd, 3rd &nbsp; 3. Submit</div>
        <small>One ballot per phone · anonymous</small>
      </section>

      <section class="sheet poster page-break">
        <div class="poster-title">${esc(S.event.name)}</div>
        <div class="poster-ask">Scan to see the leaderboard</div>
        <div class="qr-frame poster-qr">${qrSvg(boardUrl())}</div>
        <div class="poster-steps">Standings update live once the winners are revealed</div>
        <small>This code is for viewing only. Vote with the voting QR code.</small>
      </section>

      <section class="sheet stack page-break">
        <h2>Paper ballot</h2>
        <p style="color:#6a5647">Write the pot number of your favorites. 1st = 3 pts, 2nd = 2 pts, 3rd = 1 pt.</p>
        <div class="paper-ballots" id="paperBallots"></div>
        <h3 style="margin-top:var(--space-6)">Lineup</h3>
        <p style="color:#3a2a20" id="lineupLine"></p>
      </section>
    </div>
  `);
  const pb = frag.getElementById('paperBallots');
  for (let i = 0; i < 4; i++) {
    pb.append(el(`<div class="paper-ballot"><strong>${esc(S.event.name)}</strong>
      <div>1st &nbsp;#______</div><div>2nd &nbsp;#______</div><div>3rd &nbsp;#______</div></div>`));
  }
  frag.getElementById('lineupLine').textContent = S.entries.length
    ? S.entries.map((e) => `#${e.number} ${e.name}`).join('   ·   ')
    : 'Add your chilis on the Entries tab.';
  return frag;
};

/* ============================================================ boot */
document.getElementById('themeToggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
});
if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
  document.documentElement.dataset.theme = 'light';
}

window.addEventListener('hashchange', () => {
  const { name, params } = currentRoute();
  render();
});
render();
