import { ROOM_ID, WORKER_URL } from './config.js';
import { SyncClient } from './sync.js';
import { parseLeaveSheet } from './parser.js';
import {
  capacityFor, currentSprint, dayCapacity, addDays, overview, sprintDatesFor, sprintProgress, sprintNumbers, spillInFor, DEFAULT_BASE,
} from './sprints.js';
import {
  applyPaste, barSegments, clampField, cycleLeave, FIELD_KEYS, fmtDate, fmtNum, fmtShort, makeFixedItem, makeMember,
  portionOn, replaceSprints, sanitizeBackup,
} from './view.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULTS = {
  revision: 0, updatedAt: null, expiresAt: null,
  sprintBase: { ...DEFAULT_BASE }, sprints: {},
  weekendDays: [0, 6], holidays: [], members: [],
  pointsPerPersonDay: 1, bufferPct: 0,
};

const TIPS = {
  workingDays: 'Sprint days minus weekends and holidays. This is how many days each person could work with no leave.',
  activeMembers: 'People with at least one available day in this sprint. Someone who joined later or has left is not counted in the sprints they were not on the team.',
  personDays: 'Working days added up across everyone, after taking off leave. Half days count as half.',
  gross: 'Person-days multiplied by points per person-day. This is the most the team could deliver.',
  fixed: 'All the fixed story points listed for this sprint added together. They come off gross capacity first.',
  spill: 'Points carried in from the previous sprint. They come off gross capacity like fixed points.',
  buffer: 'The share of what remains (after fixed points and spillover) that you keep free for surprises.',
  net: 'What is left for new stories: (gross capacity − fixed points − spillover) minus the buffer.',
};

/** Today as YYYY-MM-DD. `?today=2026-11-18` pins it, for demos and tests. */
function today() {
  const pinned = new URLSearchParams(location.search).get('today');
  if (pinned && /^\d{4}-\d{2}-\d{2}$/.test(pinned)) return pinned;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const client = new SyncClient({
  url: `${WORKER_URL}/ws/${ROOM_ID}`,
  initial: DEFAULTS,
  onState: () => render(),
  onStatus: (status, info) => renderStatus(status, info),
});

let selected = null; // sprint number on screen
let expandedId = null; // person whose days are open

// ---------------------------------------------------------------- tooltips
const tooltip = $('tooltip');
let tipOwner = null;

function showTip(btn) {
  tipOwner = btn;
  tooltip.textContent = btn.dataset.tip;
  tooltip.hidden = false;
  btn.setAttribute('aria-describedby', 'tooltip');
  const r = btn.getBoundingClientRect();
  const w = tooltip.offsetWidth;
  const h = tooltip.offsetHeight;
  const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, 8), window.innerWidth - w - 8);
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(r.top - h - 8, 8);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}
function hideTip() {
  if (tipOwner) tipOwner.removeAttribute('aria-describedby');
  tipOwner = null;
  tooltip.hidden = true;
}
const infoOf = (e) => e.target.closest?.('.info');
document.addEventListener('mouseover', (e) => { const b = infoOf(e); if (b) showTip(b); });
document.addEventListener('mouseout', (e) => { const b = infoOf(e); if (b && document.activeElement !== b) hideTip(); });
document.addEventListener('focusin', (e) => { const b = infoOf(e); if (b) showTip(b); });
document.addEventListener('focusout', (e) => { if (infoOf(e)) hideTip(); });
document.addEventListener('click', (e) => {
  const b = infoOf(e);
  if (b) { tipOwner === b && !tooltip.hidden && e.detail === 0 ? hideTip() : showTip(b); } else hideTip();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
// Follow the icon while the page scrolls instead of vanishing; hide only if the icon leaves the screen.
window.addEventListener('scroll', () => {
  if (!tipOwner) return;
  const r = tipOwner.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) hideTip();
  else showTip(tipOwner);
}, true);

const info = (key, label) =>
  `<button type="button" class="info" data-tip="${esc(TIPS[key])}" aria-label="About ${esc(label)} result">i</button>`;

// ---------------------------------------------------------------- shared settings
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

$('weekend-days').innerHTML = DAY_NAMES.map((d, i) =>
  `<label><input type="checkbox" value="${i}" aria-label="${d} is a weekend day"><span>${d}</span></label>`).join('');

const baseNow = () => ({ ...DEFAULT_BASE, ...client.state.sprintBase });
$('anchorNumber').addEventListener('input', (e) => client.update({ sprintBase: { ...baseNow(), number: clampField('number', e.target.value) } }));
$('anchorStart').addEventListener('input', (e) => client.update({ sprintBase: { ...baseNow(), startDate: e.target.value } }));
$('anchorEnd').addEventListener('input', (e) => {
  const b = baseNow();
  if (!e.target.value || !b.startDate || e.target.value < b.startDate) return;
  const length = Math.round((Date.parse(e.target.value) - Date.parse(b.startDate)) / 86400000) + 1;
  client.update({ sprintBase: { ...b, length: clampField('length', length) } });
});
for (const f of ['pointsPerPersonDay', 'bufferPct']) $(f).addEventListener('input', (e) => client.update({ [f]: clampField(f, e.target.value) }));

$('weekend-days').addEventListener('change', () => {
  const days = [...document.querySelectorAll('#weekend-days input:checked')].map((i) => Number(i.value));
  client.update({ weekendDays: days });
});
$('holiday-add').addEventListener('click', () => {
  const v = $('holiday-input').value;
  const list = client.state.holidays;
  if (!v || list.includes(v) || list.length >= 200) return;
  client.update({ holidays: [...list, v].sort() });
  $('holiday-input').value = '';
});
$('holiday-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('holiday-add').click(); } });
$('holiday-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-date]');
  if (b) client.update({ holidays: client.state.holidays.filter((d) => d !== b.dataset.date) });
});

// ---------------------------------------------------------------- one sprint's own data
/** Save changes to one sprint. Only that sprint is sent, so other people's edits to other sprints stay. */
function updateSprint(n, patch) {
  const next = { ...(client.state.sprints?.[n] ?? {}), ...patch };
  for (const k of ['startDate', 'endDate']) if (!next[k]) delete next[k];
  client.update({ sprints: { [n]: next } });
}
const sprintCfg = (n) => client.state.sprints?.[n] ?? {};

$('overview').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-n]') ?? e.target.closest('tr[data-n]');
  if (b) { selected = Number(b.dataset.n); render(); $('sprint-heading').scrollIntoView({ block: 'start' }); }
});

$('sprintStart').addEventListener('input', (e) => { if (e.target.value) updateSprint(selected, { startDate: e.target.value }); });
$('sprintEnd').addEventListener('input', (e) => { if (e.target.value) updateSprint(selected, { endDate: e.target.value }); });
$('dates-reset').addEventListener('click', () => updateSprint(selected, { startDate: '', endDate: '' }));

$('fixed-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const points = clampField('points', $('fixed-points').value);
  const items = sprintCfg(selected).fixedItems ?? [];
  if (!(points > 0) || items.length >= 30) return;
  updateSprint(selected, { fixedItems: [...items, makeFixedItem($('fixed-label').value || 'Fixed points', points)] });
  $('fixed-label').value = '';
  $('fixed-points').value = '';
  $('fixed-label').focus();
});
$('fixed-list').addEventListener('input', (e) => {
  const input = e.target.closest('input[data-prop]');
  if (!input) return;
  const items = sprintCfg(selected).fixedItems ?? [];
  const value = input.dataset.prop === 'points' ? clampField('points', input.value) : input.value;
  if (input.dataset.prop === 'label') {
    // keep the screen-reader names of this row in step with the new name while the row stays in place
    const name = input.value || 'fixed points';
    const li = input.closest('li');
    input.setAttribute('aria-label', `Name of ${name}`);
    li.querySelector('input[data-prop="points"]')?.setAttribute('aria-label', `Points for ${name}`);
    li.querySelector('button.rm')?.setAttribute('aria-label', `Remove ${name}`);
  }
  updateSprint(selected, { fixedItems: items.map((i) => (i.id === input.dataset.id ? { ...i, [input.dataset.prop]: value } : i)) });
});
$('fixed-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (b) updateSprint(selected, { fixedItems: (sprintCfg(selected).fixedItems ?? []).filter((i) => i.id !== b.dataset.id) });
});

$('spillOut').addEventListener('input', (e) => updateSprint(selected, { spillOut: clampField('spill', e.target.value) }));
$('spillIn').addEventListener('input', (e) => updateSprint(selected, { spillIn: clampField('spill', e.target.value) }));
$('spill-auto').addEventListener('click', () => updateSprint(selected, { spillIn: null }));

// ---------------------------------------------------------------- team
$('member-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('member-name').value.trim();
  if (!name || client.state.members.length >= 100) return;
  client.update({ members: [...client.state.members, makeMember(name)] });
  $('member-name').value = '';
});

const editMember = (id, fn) => client.update({ members: client.state.members.map((m) => (m.id === id ? fn(m) : m)) });

$('team-list').addEventListener('click', (e) => {
  const cell = e.target.closest('button.cell');
  if (cell) { editMember(cell.dataset.member, (m) => ({ ...m, leave: cycleLeave(m.leave, cell.dataset.date) })); return; }
  const edit = e.target.closest('button.edit');
  if (edit) { expandedId = expandedId === edit.dataset.member ? null : edit.dataset.member; render(); return; }
  const rm = e.target.closest('button.rm');
  if (rm) {
    if (expandedId === rm.dataset.member) expandedId = null;
    client.update({ members: client.state.members.filter((m) => m.id !== rm.dataset.member) });
  }
});
$('team-list').addEventListener('input', (e) => {
  const input = e.target.closest('input[data-prop]');
  if (!input) return;
  const { member, prop } = input.dataset;
  editMember(member, (m) => {
    const next = { ...m, [prop]: input.value };
    if (!next[prop]) delete next[prop];
    return next;
  });
});
// While someone is typing a date in a person's panel, do not rebuild the list under them.
$('team-list').addEventListener('focusout', (e) => {
  if (e.target.matches?.('input[data-prop]')) setTimeout(() => render(), 0);
});

// ---------------------------------------------------------------- render
function setValue(el, value) {
  if (document.activeElement !== el && el.value !== String(value)) el.value = String(value);
}

function render() {
  const s = client.state;
  const base = { ...DEFAULT_BASE, ...s.sprintBase };
  const now = today();

  setValue($('anchorNumber'), base.number);
  setValue($('anchorStart'), base.startDate);
  setValue($('anchorEnd'), base.startDate ? addDays(base.startDate, base.length - 1) : '');
  setValue($('pointsPerPersonDay'), s.pointsPerPersonDay ?? 1);
  setValue($('bufferPct'), s.bufferPct ?? 0);
  for (const i of document.querySelectorAll('#weekend-days input')) i.checked = s.weekendDays.includes(Number(i.value));
  $('holiday-list').innerHTML = s.holidays.map((d) =>
    `<li>${esc(fmtDate(d, { year: true }))}<button type="button" data-date="${d}" aria-label="Remove holiday ${esc(fmtDate(d, { year: true }))}">×</button></li>`).join('');

  const numbers = sprintNumbers(s, now);
  const hasSprints = numbers.length > 0;
  const current = currentSprint(s, now);
  if (hasSprints && !numbers.includes(selected)) selected = current;

  $('setup-note').hidden = hasSprints;
  $('sprint-area').hidden = !hasSprints;
  $('overview-section').hidden = !hasSprints;
  $('rail-sprint').hidden = !hasSprints;
  if (hasSprints) $('rail-sprint-name').textContent = `Sprint ${selected}`;

  const cap = hasSprints ? capacityFor(s, selected) : null;
  if (hasSprints) {
    renderSprint(s, cap, current);
    renderLeft(s, now);
    renderFixed(s);
    renderSpill(s);
    renderOverview(s, now);
  }
  renderTeam(s, cap);
  renderToday(s, now);
  renderRetention(s);
}

function renderSprint(s, cap, current) {
  const r = cap.sprint;
  const tag = selected === current ? 'current' : selected < current ? 'past' : 'upcoming';
  $('sprint-heading').textContent = `Sprint ${selected} (${tag})`;
  $('sprint-dates').textContent = `${fmtDate(r.start, { year: true })} to ${fmtDate(r.end, { year: true })}. ${r.numDays} calendar days, ${cap.workingDays} working.`;
  setValue($('sprintStart'), r.start);
  setValue($('sprintEnd'), r.end);
  const custom = Boolean(sprintCfg(selected).startDate || sprintCfg(selected).endDate);
  $('dates-reset').hidden = !custom;
  document.querySelector('.override summary').textContent = custom ? 'Dates changed for this sprint' : 'Change this sprint\'s dates';

  $('net').textContent = fmtNum(cap.net);
  $('warnings').innerHTML = cap.warnings.map((w) => `<p class="warning">${esc(w)}</p>`).join('');

  const bar = $('bar');
  const segs = barSegments(cap);
  bar.classList.toggle('empty', segs.length === 0);
  for (const key of ['fixed', 'spill', 'buffer', 'net']) {
    let el = bar.querySelector(`.seg.${key}`);
    if (!el) { el = document.createElement('div'); el.className = `seg ${key}`; bar.append(el); }
    const seg = segs.find((x) => x.key === key);
    el.hidden = !seg;
    el.style.flexGrow = seg ? String(seg.flex) : '0';
  }
  bar.setAttribute('aria-label', `Gross capacity ${fmtNum(cap.gross)} points: ${fmtNum(cap.fixed)} fixed, ${fmtNum(cap.spill)} spillover, ${fmtNum(cap.bufferPoints)} buffer, ${fmtNum(cap.net)} for new stories`);

  const fixedItems = (s.sprints?.[selected]?.fixedItems ?? []).filter((i) => Number(i.points) > 0);
  $('bar-legend').innerHTML = [
    ...(fixedItems.length ? fixedItems.map((i) => ['var(--fixed)', i.label || 'Fixed points', Number(i.points)]) : [['var(--fixed)', 'Fixed', cap.fixed]]),
    ['var(--spill)', 'Spillover', cap.spill],
    ['var(--buffer)', 'Buffer', cap.bufferPoints],
    ['var(--net)', 'For new stories', cap.net],
  ].map(([color, label, v]) => `<li><i style="background:${color}"></i>${label} <b>${fmtNum(v)}</b></li>`).join('');

  const rows = [
    ['workingDays', 'Working days', cap.workingDays],
    ['activeMembers', 'Active people', cap.activeMembers],
    ['personDays', 'Person-days', cap.personDays],
    ['gross', 'Gross capacity', cap.gross],
    ['fixed', 'Fixed points', cap.fixed],
    ['spill', 'Spillover in', cap.spill],
    ['buffer', `Buffer (${fmtNum(cap.bufferPct)}%)`, cap.bufferPoints],
    ['net', 'For new stories', cap.net],
  ];
  $('breakdown').innerHTML = rows.map(([k, label, v]) =>
    `<div><dt>${esc(label)} ${info(k, label)}</dt><dd data-k="${k}">${fmtNum(v)}</dd></div>`).join('');
}

function renderLeft(s, now) {
  const p = sprintProgress(s, selected, now);
  const el = $('sprint-left');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  el.className = `left ${p?.status ?? ''}`;
  if (!p) { el.textContent = ''; return; }
  if (p.status === 'current') {
    el.innerHTML = `<b>${plural(p.workingLeft, 'working day')} left</b> <span>${p.endsIn === 0 ? 'ends today' : `ends in ${plural(p.endsIn, 'day')}`}</span>`;
  } else if (p.status === 'upcoming') el.textContent = `Starts in ${plural(p.startsIn, 'day')}`;
  else el.textContent = `Ended ${plural(p.endedAgo, 'day')} ago`;
}

function renderFixed(s) {
  const items = s.sprints?.[selected]?.fixedItems ?? [];
  const total = items.reduce((sum, i) => sum + (Number(i.points) || 0), 0);
  const list = $('fixed-list');
  // while someone types in a name or points box, only the total changes
  if (document.activeElement?.matches?.('#fixed-list input')) {
    const t = list.querySelector('.item-total .item-points');
    if (t) t.textContent = fmtNum(total);
    return;
  }
  list.innerHTML = items.length
    ? items.map((i) => `<li><input type="text" class="item-label" maxlength="80" data-id="${esc(i.id)}" data-prop="label" value="${esc(i.label ?? '')}" placeholder="Fixed points" aria-label="Name of ${esc(i.label || 'fixed points')}">` +
      `<input type="number" class="item-points" min="0" max="100000" step="0.5" inputmode="decimal" data-id="${esc(i.id)}" data-prop="points" value="${esc(String(i.points ?? 0))}" aria-label="Points for ${esc(i.label || 'fixed points')}">` +
      `<button type="button" class="rm" data-id="${esc(i.id)}" aria-label="Remove ${esc(i.label || 'fixed points')}">×</button></li>`).join('') +
      `<li class="item-total"><span class="item-label">Total</span><span class="item-points">${fmtNum(total)}</span></li>`
    : '<li class="empty-note">Nothing added yet. Add support, recurring work or committed items.</li>';
}

function renderSpill(s) {
  const own = s.sprints?.[selected]?.spillIn;
  const overridden = own !== null && own !== undefined;
  setValue($('spillIn'), spillInFor(s, selected));
  setValue($('spillOut'), s.sprints?.[selected]?.spillOut ?? 0);
  const prev = Number(s.sprints?.[selected - 1]?.spillOut) || 0;
  $('spillIn-hint').textContent = selected <= 1 ? 'This is the first sprint.'
    : overridden ? `Typed in. Sprint ${selected - 1} says ${fmtNum(prev)}.`
      : `From Sprint ${selected - 1}'s spillover out.`;
  $('spill-auto').hidden = !overridden;
}

function renderOverview(s, now) {
  const rows = overview(s, now);
  $('overview').innerHTML = `<thead><tr><th scope="col">Sprint</th><th scope="col">Dates</th><th scope="col" class="n">Active people</th><th scope="col" class="n">Gross</th><th scope="col" class="n">Fixed</th><th scope="col" class="n">Spillover in</th><th scope="col" class="n">For new stories</th></tr></thead><tbody>${
    rows.map((r) => `<tr data-n="${r.number}" class="${r.number === selected ? 'sel' : ''}"><th scope="row"><button type="button" class="link" data-n="${r.number}">Sprint ${r.number}</button>${r.isCurrent ? ' <span class="pill">Current</span>' : ''}</th><td>${esc(fmtShort(r.start))} – ${esc(fmtShort(r.end))}</td><td class="n">${r.activeMembers}</td><td class="n">${fmtNum(r.gross)}</td><td class="n">${fmtNum(r.fixed)}</td><td class="n">${fmtNum(r.spillIn)}</td><td class="n strong">${fmtNum(r.net)}</td></tr>`).join('')
  }</tbody>`;
}

function renderTeam(s, cap) {
  const n = s.members.length;
  $('team-count').textContent = !n ? 'No one on the team yet.'
    : cap ? `${cap.activeMembers} active in Sprint ${selected}, ${n} ${n === 1 ? 'person' : 'people'} on the list.`
      : `${n} ${n === 1 ? 'person' : 'people'} on the list.`;

  const table = $('team-list');
  const ae = document.activeElement;
  const typing = ae?.matches?.('#team-list input');
  const byId = new Map((cap?.members ?? []).map((m) => [m.id, m]));

  if (!n) { table.innerHTML = '<tbody><tr><td class="empty-note">Add a person above, or paste your leave table.</td></tr></tbody>'; return; }
  if (!cap) {
    // no sprint yet: names only, the calendar appears once the current sprint is set
    table.innerHTML = '<tbody>' + s.members.map((m) =>
      `<tr class="person" data-id="${esc(m.id)}"><th scope="row" class="pname"><span class="p-name">${esc(m.name)}</span></th>` +
      `<td class="pact"><button type="button" class="rm" data-member="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">×</button></td></tr>`).join('') +
      '</tbody><tfoot><tr><td colspan="2" class="empty-note">Set the current sprint on the left to see the calendar.</td></tr></tfoot>';
    return;
  }

  // Someone is typing a date in a person's panel: update totals and notes only, so the input keeps its caret.
  if (typing) {
    for (const m of s.members) {
      const c = byId.get(m.id);
      const sum = table.querySelector(`[data-sum="${CSS.escape(m.id)}"]`);
      if (sum && c) sum.innerHTML = sumCell(c);
      const name = table.querySelector(`tr.person[data-id="${CSS.escape(m.id)}"] .pname`);
      if (name && c) {
        name.querySelector('small')?.remove();
        const note = memberNote(c);
        if (note) name.insertAdjacentHTML('beforeend', `<small>${note}</small>`);
        name.closest('tr').classList.toggle('idle', c.available === 0);
      }
    }
    return;
  }
  const focused = ae?.closest?.('#team-list') ? { ...ae.dataset } : null;
  const dates = cap.sprint.dates;
  const weekend = new Set(s.weekendDays);
  const holidays = new Set(s.holidays);
  const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

  // columns: one per day, except that a run of weekend days (Saturday and Sunday) is a single "Weekend" column
  const cols = [];
  for (const d of dates) {
    const last = cols[cols.length - 1];
    if (weekend.has(dow(d))) {
      if (last?.weekend) last.dates.push(d); else cols.push({ weekend: true, dates: [d] });
    } else cols.push({ weekend: false, dates: [d], date: d });
  }

  const head = cols.map((col) => {
    if (col.weekend) {
      const from = col.dates[0], to = col.dates[col.dates.length - 1];
      const range = from === to ? String(Number(from.slice(8))) : `${Number(from.slice(8))}–${Number(to.slice(8))}`;
      return `<th scope="col" class="dh weekend" title="Weekend ${esc(fmtDate(from))}${from === to ? '' : ` to ${esc(fmtDate(to))}`}"><i></i><span>Wknd</span><b>${range}</b></th>`;
    }
    const d = col.date;
    const rest = holidays.has(d) ? 'holiday' : '';
    const first = d === dates[0] || d.endsWith('-01');
    return `<th scope="col" class="dh ${rest}" title="${esc(fmtDate(d, { year: true }))}${rest ? ' (holiday)' : ''}"><i>${first ? fmtDate(d).split(' ')[2] ?? '' : ''}</i><span>${DAY_NAMES[dow(d)].slice(0, 2)}</span><b>${Number(d.slice(8))}</b></th>`;
  }).join('');

  const rows = s.members.map((m) => {
    const c = byId.get(m.id);
    const open = expandedId === m.id;
    const note = c ? memberNote(c) : '';
    const cells = cols.map((col) => {
      if (col.weekend) return '<td class="dc nw wk"><span class="cell rest" title="Weekend"></span></td>';
      const d = col.date;
      const nonWorking = holidays.has(d);
      if ((m.from && d < m.from) || (m.until && d > m.until)) return '<td class="dc"><span class="cell na" title="Not on the team"></span></td>';
      const p = portionOn(m.leave, d);
      const state = p === 0 ? (nonWorking ? 'rest' : 'on') : p === 1 ? 'off' : 'half';
      const label = p === 0 ? (nonWorking ? 'not a working day' : 'working') : p === 1 ? 'off' : 'half day';
      return `<td class="dc${nonWorking ? ' nw' : ''}"><button type="button" class="cell ${state}" data-member="${esc(m.id)}" data-date="${d}" aria-label="${esc(m.name)}, ${esc(fmtDate(d))}: ${label}. Select to change." title="${esc(fmtDate(d))}: ${label}"></button></td>`;
    }).join('');
    return `<tr class="person${c && c.available === 0 ? ' idle' : ''}" data-id="${esc(m.id)}">` +
      `<th scope="row" class="pname"><span class="p-name" title="${esc(m.name)}">${esc(m.name)}</span>${note ? `<small>${note}</small>` : ''}</th>${cells}` +
      `<td class="psum" data-sum="${esc(m.id)}">${c ? sumCell(c) : ''}</td>` +
      `<td class="pact"><button type="button" class="link edit" data-member="${esc(m.id)}" aria-expanded="${open}" aria-label="Edit dates for ${esc(m.name)}">${open ? 'Close' : 'Dates'}</button>` +
      `<button type="button" class="rm" data-member="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">×</button></td></tr>` +
      (open ? `<tr class="dates-row"><td colspan="${cols.length + 3}">${personDates(m)}</td></tr>` : '');
  }).join('');

  table.innerHTML = `<thead><tr><th scope="col" class="pname">Person</th>${head}<th scope="col" class="psum">Days</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody>`;

  if (focused?.member && focused?.date) {
    table.querySelector(`button.cell[data-member="${CSS.escape(focused.member)}"][data-date="${focused.date}"]`)?.focus();
  }
}

const memberNote = (c) => (c.activeDays === 0 ? 'Not on the team this sprint' : c.available === 0 ? 'Off the whole sprint' : '');
const sumCell = (c) => `<b>${fmtNum(c.available)}</b><small>${fmtNum(c.points)} pts</small>`;

function personDates(m) {
  return `<div class="joined">
      <label>Joined <button type="button" class="info" data-tip="The first day this person is on the team. Leave empty if they were here before the sprints you look at. Earlier sprints will not count them." aria-label="About joined date">i</button>
        <input type="date" data-member="${esc(m.id)}" data-prop="from" value="${esc(m.from ?? '')}" aria-label="Joined ${esc(m.name)}"></label>
      <label>Last day <button type="button" class="info" data-tip="The last day this person is on the team. Leave empty if they are still here. Later sprints will not count them." aria-label="About last day">i</button>
        <input type="date" data-member="${esc(m.id)}" data-prop="until" value="${esc(m.until ?? '')}" aria-label="Last day of ${esc(m.name)}"></label>
    </div>`;
}

/** The blue panel for the sprint that is running now: points left, days left, active people, who is out today. */
function renderToday(s, now) {
  const card = $('today');
  const current = currentSprint(s, now);
  card.hidden = current === null || !sprintNumbers(s, now).length;
  if (card.hidden) return;
  const cap = capacityFor(s, current);
  const prog = sprintProgress(s, current, now);
  const d = dayCapacity(s, now);
  $('cur-n').textContent = String(current);
  $('cur-points').textContent = fmtNum(cap.net);
  $('cur-days').textContent = prog?.status === 'current' ? String(prog.workingLeft) : prog?.status === 'upcoming' ? String(cap.workingDays) : '0';
  $('cur-active').textContent = String(cap.activeMembers);
  $('cur-leave-count').textContent = String(d.onLeave.length);

  const label = fmtDate(now);
  const line = $('today-line');
  const people = $('today-people');
  const leave = $('today-leave');
  if (!d.working) {
    line.textContent = `${label}: ${d.reason === 'holiday' ? 'holiday' : 'weekend'}, not a working day.`;
    people.innerHTML = '';
    people.removeAttribute('aria-label');
    leave.textContent = '';
    return;
  }
  line.innerHTML = `<b>${fmtNum(d.available)}</b> of ${d.team} ${d.team === 1 ? 'person' : 'people'} available on ${esc(label)}, <b>${fmtNum(d.points)}</b> points`;
  const byName = new Map(d.onLeave.map((l) => [l.name, l.portion]));
  const squares = [];
  for (const m of s.members) {
    if ((m.from && now < m.from) || (m.until && now > m.until)) continue;
    const p = byName.get(m.name) ?? 0;
    squares.push(`<span class="sq ${p === 0 ? 'on' : p >= 1 ? 'off' : 'half'}" title="${esc(m.name)}${p ? (p >= 1 ? ': on leave' : ': half day') : ''}"></span>`);
  }
  people.innerHTML = squares.join('');
  people.setAttribute('aria-label', `${fmtNum(d.available)} of ${d.team} available today`);
  leave.textContent = d.onLeave.length
    ? `On leave today: ${d.onLeave.map((l) => (l.portion >= 1 ? l.name : `${l.name} (half day)`)).join(', ')}`
    : d.team ? 'Nobody is on leave today.' : '';
}

function renderRetention(s) {
  const base = 'Everything here is deleted 3 months after the last edit. Only names, leave days, dates and numbers are stored.';
  $('retention').textContent = s.expiresAt
    ? `${base} Next automatic deletion: ${fmtDate(new Date(s.expiresAt).toISOString().slice(0, 10), { year: true })}.`
    : base;
}

function renderStatus(status, extra = {}) {
  const el = $('sync-status');
  el.dataset.state = status;
  const time = extra.savedAt ? new Date(extra.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  el.textContent = {
    connecting: 'Connecting…',
    saving: 'Saving…',
    saved: time ? `Saved ${time}` : 'Saved',
    offline: 'Offline. Retrying…',
    error: `Could not save: ${extra.message ?? 'try again'}`,
  }[status] ?? '';
}

// ---------------------------------------------------------------- notices
let noticeTimer;
function notice(text, isError = false) {
  const n = $('notice');
  n.textContent = text;
  n.classList.toggle('err', isError);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { n.textContent = ''; }, 6000);
}

// ---------------------------------------------------------------- backup
$('export').addEventListener('click', () => {
  const fields = Object.fromEntries(Object.entries(client.state).filter(([k]) => FIELD_KEYS.includes(k)));
  const blob = new Blob([JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), fields }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sprint-planner-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  notice('Backup downloaded.');
});
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const fields = sanitizeBackup(JSON.parse(await file.text()));
    if (!fields) throw new Error('not a backup');
    if (fields.sprints) fields.sprints = replaceSprints(client.state.sprints, fields.sprints);
    client.update(fields);
    notice('Backup restored.');
  } catch {
    notice('That file is not a Sprint Planner backup.', true);
  }
});

// ---------------------------------------------------------------- delete
const deleteDialog = $('delete-dialog');
$('delete-open').addEventListener('click', () => deleteDialog.showModal());
$('delete-cancel').addEventListener('click', () => deleteDialog.close());
deleteDialog.addEventListener('close', () => {
  if (deleteDialog.returnValue !== 'delete') return;
  deleteDialog.returnValue = '';
  notice(client.clear() ? 'All data deleted.' : 'You are offline. Reconnect to delete the data.', !client.connected());
});

// ---------------------------------------------------------------- paste
const pasteDialog = $('paste-dialog');
let pasted = null; // { members, newHints }

$('paste-open').addEventListener('click', () => { pasteDialog.showModal(); $('paste-text').focus(); previewPaste(); });
$('paste-cancel').addEventListener('click', () => pasteDialog.close());
for (const id of ['paste-text', 'paste-convention', 'paste-order', 'paste-blank', 'paste-others']) {
  $(id).addEventListener(id === 'paste-text' ? 'input' : 'change', previewPaste);
}

function previewPaste() {
  const s = client.state;
  const text = $('paste-text').value;
  const out = $('paste-preview');
  const apply = $('paste-apply');
  pasted = null;
  apply.disabled = true;
  if (!text.trim()) { out.innerHTML = ''; return; }

  const anchor = { ...DEFAULT_BASE, ...s.sprintBase };
  const parsed = parseLeaveSheet(text, {
    yearHint: Number((anchor.startDate || today()).slice(0, 4)),
    weekendDays: s.weekendDays,
    convention: $('paste-convention').value,
    order: $('paste-order').value,
    blankAsOff: $('paste-blank').checked,
  });

  if (parsed.layout === 'unknown') {
    out.innerHTML = parsed.errors.map((e) => `<p class="msg err">${esc(e.message)}</p>`).join('');
    return;
  }

  const markOthersOff = $('paste-others').checked;
  const members = applyPaste(s.members, parsed, { markOthersOff });
  if (members.length > 100) {
    out.innerHTML = '<p class="msg err">That would be more than 100 people. Remove some people first.</p>';
    return;
  }
  const newHints = parsed.holidayHints.filter((d) => !s.holidays.includes(d));
  const keepHints = () => (document.getElementById('paste-hint')?.checked ?? false);
  const holidays = [...new Set([...s.holidays, ...(newHints.length && keepHints() ? newHints : [])])].sort();
  const next = { ...s, members, holidays };
  const hasSprints = sprintNumbers(next, today()).length > 0;
  const cap = hasSprints ? capacityFor(next, selected) : null;

  const names = new Set(parsed.members.map((p) => p.name.trim().toLowerCase()));
  const others = s.members.filter((m) => !names.has(m.name.trim().toLowerCase()));
  const msgs = [];
  const range = parsed.columns.length ? `${fmtDate(parsed.columns[0], { year: true })} to ${fmtDate(parsed.columns[parsed.columns.length - 1], { year: true })}` : '';
  msgs.push(`<p class="msg">${esc(parsed.layout === 'matrix'
    ? `Read ${parsed.members.length} people and ${parsed.columns.length} date columns (${range}). Cells read as ${parsed.convention === 'availability' ? 'availability: 1 working, 0 off' : 'leave: a mark means away'}.`
    : `Read ${parsed.members.length} people from a list of leave dates.`)}</p>`);
  if (others.length) {
    msgs.push(`<p class="msg">${others.length} ${others.length === 1 ? 'person on your list is' : 'people on your list are'} not in this paste (${esc(others.map((o) => o.name).join(', '))}). ${markOthersOff ? 'They keep their history and are off on these dates.' : 'They keep their leave as it is.'}</p>`);
  }
  if (!hasSprints) msgs.push('<p class="msg warn">Set the current sprint first to see availability per sprint. The leave is still saved.</p>');
  for (const w of parsed.warnings) msgs.push(`<p class="msg warn">${esc(w)}</p>`);
  for (const e of parsed.errors.slice(0, 5)) msgs.push(`<p class="msg err">${e.row ? `Row ${e.row}: ` : ''}${esc(e.message)}</p>`);
  if (parsed.errors.length > 5) msgs.push(`<p class="msg err">${parsed.errors.length - 5} more problems not shown.</p>`);
  if (newHints.length) {
    msgs.push(`<label class="holiday"><input type="checkbox" id="paste-hint" ${keepHints() ? 'checked' : ''}> Everyone is off on ${esc(newHints.map((d) => fmtDate(d)).join(', '))}. Also add as holidays (their days off are kept either way).</label>`);
  }
  if (cap) {
    const rows = cap.members.filter((m) => names.has(m.name.trim().toLowerCase())).map((m) => `<tr><td>${esc(m.name)}</td><td class="n">${fmtNum(m.leaveDays)}</td><td class="n">${fmtNum(m.available)}</td></tr>`).join('');
    msgs.push(`<div class="scroll"><table><thead><tr><th>Person</th><th class="n">Leave in Sprint ${selected}</th><th class="n">Available</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  } else {
    msgs.push(`<div class="scroll"><table><thead><tr><th>Person</th><th class="n">Leave days</th></tr></thead><tbody>${members.filter((m) => names.has(m.name.trim().toLowerCase())).map((m) => `<tr><td>${esc(m.name)}</td><td class="n">${fmtNum(m.leave.reduce((a, l) => a + l.portion, 0))}</td></tr>`).join('')}</tbody></table></div>`);
  }

  out.innerHTML = msgs.join('');
  $('paste-hint')?.addEventListener('change', previewPaste);
  pasted = { members, holidays, newHints };
  apply.disabled = parsed.members.length === 0;
}

$('paste-form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'apply' || !pasted) { e.preventDefault(); return; }
  const fields = { members: pasted.members };
  if (pasted.newHints.length && $('paste-hint')?.checked) fields.holidays = pasted.holidays;
  client.update(fields);
  $('paste-text').value = '';
  $('paste-preview').innerHTML = '';
  pasted = null;
  notice('Leave applied to the team.');
});

// Do not lose an edit made just before the tab is closed or hidden.
window.addEventListener('pagehide', () => client.flushNow());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') client.flushNow(); });

// ---------------------------------------------------------------- start
$('room-name').textContent = ROOM_ID;
render();
renderStatus('connecting');
client.connect();
