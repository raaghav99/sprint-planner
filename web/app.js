import { ROOM_ID, WORKER_URL } from './config.js';
import { SyncClient } from './sync.js';
import { computeCapacity, workingDays } from './capacity.js';
import { parseLeaveSheet } from './parser.js';
import {
  barSegments, clampField, cycleLeave, fmtDate, fmtNum, makeMember, mergeMembers, monthSpans, portionOn, sanitizeBackup,
} from './view.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULTS = {
  revision: 0, updatedAt: null, expiresAt: null,
  sprintName: '', dateMode: 'range', startDate: '', endDate: '', numDays: 14,
  weekendDays: [0, 6], holidays: [], members: [],
  pointsPerPersonDay: 1, fixedPoints: 0, bufferPct: 0,
};

const TIPS = {
  workingDays: 'Sprint days minus weekends and holidays. This is how many days each person could work with no leave.',
  personDays: 'Working days added up across everyone, after taking off leave. Half days count as half.',
  gross: 'Person-days multiplied by points per person-day. This is the most the team could deliver.',
  fixed: 'Points already committed before planning. They come off gross capacity first.',
  buffer: 'The share of what remains (after fixed points) that you keep free for surprises.',
  net: 'What is left for new stories: (gross capacity − fixed points) minus the buffer.',
};

const client = new SyncClient({
  url: `${WORKER_URL}/ws/${ROOM_ID}`,
  initial: DEFAULTS,
  onState: () => render(),
  onStatus: (status, info) => renderStatus(status, info),
});

let cap = computeCapacity(client.state);

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

// ---------------------------------------------------------------- inputs
const TEXT_FIELDS = ['sprintName', 'startDate', 'endDate'];
const NUM_FIELDS = ['numDays', 'pointsPerPersonDay', 'fixedPoints', 'bufferPct'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

$('weekend-days').innerHTML = DAY_NAMES.map((d, i) =>
  `<label><input type="checkbox" value="${i}" aria-label="${d} is a weekend day"><span>${d}</span></label>`).join('');

for (const f of TEXT_FIELDS) $(f).addEventListener('input', (e) => client.update({ [f]: e.target.value }));
for (const f of NUM_FIELDS) $(f).addEventListener('input', (e) => client.update({ [f]: clampField(f, e.target.value) }));
for (const r of document.querySelectorAll('input[name="dateMode"]')) {
  r.addEventListener('change', (e) => { if (e.target.checked) client.update({ dateMode: e.target.value }); });
}
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

$('member-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('member-name').value.trim();
  if (!name || client.state.members.length >= 100) return;
  client.update({ members: [...client.state.members, makeMember(name)] });
  $('member-name').value = '';
});

$('grid-wrap').addEventListener('click', (e) => {
  const cell = e.target.closest('button.cell');
  if (cell) {
    const { member, date } = cell.dataset;
    client.update({
      members: client.state.members.map((m) => (m.id === member ? { ...m, leave: cycleLeave(m.leave, date) } : m)),
    });
    return;
  }
  const rm = e.target.closest('button.rm');
  if (rm) client.update({ members: client.state.members.filter((m) => m.id !== rm.dataset.member) });
});

// ---------------------------------------------------------------- render
function setValue(el, value) {
  if (document.activeElement !== el && el.value !== String(value)) el.value = String(value);
}

function render() {
  const s = client.state;
  cap = computeCapacity(s);

  for (const f of [...TEXT_FIELDS, ...NUM_FIELDS]) setValue($(f), s[f] ?? '');
  for (const r of document.querySelectorAll('input[name="dateMode"]')) r.checked = r.value === s.dateMode;
  $('field-end').hidden = s.dateMode === 'days';
  $('field-days').hidden = s.dateMode !== 'days';
  for (const i of document.querySelectorAll('#weekend-days input')) i.checked = s.weekendDays.includes(Number(i.value));

  $('holiday-list').innerHTML = s.holidays.map((d) =>
    `<li>${esc(fmtDate(d, { year: true }))}<button type="button" data-date="${d}" aria-label="Remove holiday ${esc(fmtDate(d, { year: true }))}">×</button></li>`).join('');

  renderSummary(s);
  renderResults();
  renderGrid(s);
  renderRetention(s);
}

function renderSummary(s) {
  const r = cap.sprint;
  $('date-summary').textContent = r.dates.length
    ? `${fmtDate(r.start, { year: true })} to ${fmtDate(r.end, { year: true })}. ${r.numDays} calendar days, ${cap.workingDays} working.`
    : s.dateMode === 'days' ? 'Pick a start date and a number of days.' : 'Pick a start date and an end date.';
}

function renderResults() {
  $('net').textContent = fmtNum(cap.net);
  $('warnings').innerHTML = cap.warnings.map((w) => `<p class="warning">${esc(w)}</p>`).join('');

  const bar = $('bar');
  const segs = barSegments(cap);
  bar.classList.toggle('empty', segs.length === 0);
  for (const key of ['fixed', 'buffer', 'net']) {
    let el = bar.querySelector(`.seg.${key}`);
    if (!el) { el = document.createElement('div'); el.className = `seg ${key}`; bar.append(el); }
    const seg = segs.find((x) => x.key === key);
    el.hidden = !seg;
    el.style.flexGrow = seg ? String(seg.flex) : '0';
  }
  bar.setAttribute('aria-label', `Gross capacity ${fmtNum(cap.gross)} points: ${fmtNum(cap.fixed)} fixed, ${fmtNum(cap.bufferPoints)} buffer, ${fmtNum(cap.net)} for new stories`);

  $('bar-legend').innerHTML = [
    ['fixed', 'var(--fixed)', 'Fixed', cap.fixed],
    ['buffer', 'var(--buffer)', 'Buffer', cap.bufferPoints],
    ['net', 'var(--net)', 'For new stories', cap.net],
  ].map(([, color, label, v]) => `<li><i style="background:${color}"></i>${label} <b>${fmtNum(v)}</b></li>`).join('');

  const rows = [
    ['workingDays', 'Working days', cap.workingDays],
    ['personDays', 'Person-days', cap.personDays],
    ['gross', 'Gross capacity', cap.gross],
    ['fixed', 'Fixed points', cap.fixed],
    ['buffer', `Buffer (${fmtNum(cap.bufferPct)}%)`, cap.bufferPoints],
    ['net', 'For new stories', cap.net],
  ];
  $('breakdown').innerHTML = rows.map(([k, label, v]) =>
    `<div><dt>${esc(label)} ${info(k, label)}</dt><dd data-k="${k}">${fmtNum(v)}</dd></div>`).join('');
}

function renderGrid(s) {
  const wrap = $('grid-wrap');
  const focused = document.activeElement?.closest?.('#grid-wrap') ? document.activeElement.dataset : null;
  const days = workingDays(s);

  if (!s.members.length) {
    wrap.innerHTML = '<p class="empty-note">No one is in this sprint yet. Add a person above, or paste your leave table.</p>';
    return;
  }
  const note = days.length ? '' : '<p class="empty-note">Set the sprint dates to see each person\'s days.</p>';

  const byId = new Map(cap.members.map((m) => [m.id, m]));
  const months = monthSpans(days);
  const isWeekStart = (d, i) => i > 0 && new Date(`${d}T00:00:00Z`).getUTCDay() === 1;

  const head1 = `<tr><th></th>${months.map((m) => `<th class="month" colspan="${m.span}">${m.label}</th>`).join('')}<th></th></tr>`;
  const head2 = `<tr><th class="who"><span class="sr-only">Person</span></th>${days.map((d, i) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return `<th class="dh${isWeekStart(d, i) ? ' wk' : ''}" scope="col" title="${esc(fmtDate(d, { year: true }))}"><b>${Number(d.slice(8))}</b>${DAY_NAMES[dow].slice(0, 2)}</th>`;
  }).join('')}<th class="total" scope="col">Days</th></tr>`;

  const body = s.members.map((m) => {
    const cells = days.map((d, i) => {
      const p = portionOn(m.leave, d);
      const state = p === 0 ? 'on' : p === 1 ? 'off' : 'half';
      const label = p === 0 ? 'working' : p === 1 ? 'off' : 'half day';
      return `<td class="${isWeekStart(d, i) ? 'wk' : ''}"><button type="button" class="cell ${state}" data-member="${esc(m.id)}" data-date="${d}" aria-label="${esc(m.name)}, ${esc(fmtDate(d))}: ${label}. Select to change." title="${esc(fmtDate(d))}: ${label}"></button></td>`;
    }).join('');
    const total = byId.get(m.id)?.available ?? 0;
    return `<tr><th class="who" scope="row"><div class="who-inner"><span class="who-name" title="${esc(m.name)}">${esc(m.name)}</span><button type="button" class="rm" data-member="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">×</button></div></th>${cells}<td class="total">${days.length ? fmtNum(total) : '–'}</td></tr>`;
  }).join('');

  wrap.innerHTML = `${note}<table class="grid"><thead>${head1}${head2}</thead><tbody>${body}</tbody></table>`;

  if (focused?.member && focused?.date) {
    wrap.querySelector(`button.cell[data-member="${CSS.escape(focused.member)}"][data-date="${focused.date}"]`)?.focus();
  }
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
  const fields = Object.fromEntries(Object.entries(client.state).filter(([k]) =>
    ['sprintName', 'dateMode', 'startDate', 'endDate', 'numDays', 'weekendDays', 'holidays', 'members', 'pointsPerPersonDay', 'fixedPoints', 'bufferPct'].includes(k)));
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), fields }, null, 2)], { type: 'application/json' });
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
let pasted = null; // { parsed, hints }

$('paste-open').addEventListener('click', () => { pasteDialog.showModal(); $('paste-text').focus(); previewPaste(); });
$('paste-cancel').addEventListener('click', () => pasteDialog.close());
for (const id of ['paste-text', 'paste-convention', 'paste-order', 'paste-blank']) {
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

  const haveDates = cap.sprint.dates.length > 0;
  const parsed = parseLeaveSheet(text, {
    sprintStart: haveDates ? cap.sprint.start : undefined,
    sprintEnd: haveDates ? cap.sprint.end : undefined,
    weekendDays: s.weekendDays,
    convention: $('paste-convention').value,
    order: $('paste-order').value,
    blankAsOff: $('paste-blank').checked,
  });

  const msgs = [];
  if (parsed.layout === 'unknown') {
    out.innerHTML = parsed.errors.map((e) => `<p class="msg err">${esc(e.message)}</p>`).join('');
    return;
  }

  const newHints = parsed.holidayHints.filter((d) => !s.holidays.includes(d));
  const members = mergeMembers(s.members, parsed.members);
  if (members.length > 100) {
    out.innerHTML = '<p class="msg err">That is more than 100 people. Paste fewer rows.</p>';
    return;
  }
  const keepHints = () => (document.getElementById('paste-hint')?.checked ?? true);
  const preview = computeCapacity({ ...s, holidays: [...new Set([...s.holidays, ...(newHints.length && keepHints() ? newHints : [])])], members });

  const read = parsed.layout === 'matrix'
    ? `Read ${members.length} people and ${parsed.columns.length} date columns (${parsed.columns.length - parsed.outsideColumns.length} inside this sprint). Cells read as ${parsed.convention === 'availability' ? 'availability: 1 working, 0 off' : 'leave: a mark means away'}.`
    : `Read ${members.length} people from a list of leave dates.`;
  msgs.push(`<p class="msg">${esc(read)}</p>`);
  if (!haveDates) msgs.push('<p class="msg warn">Set the sprint dates first so only this sprint\'s columns are used.</p>');
  for (const w of parsed.warnings) msgs.push(`<p class="msg warn">${esc(w)}</p>`);
  for (const e of parsed.errors.slice(0, 5)) msgs.push(`<p class="msg err">${e.row ? `Row ${e.row}: ` : ''}${esc(e.message)}</p>`);
  if (parsed.errors.length > 5) msgs.push(`<p class="msg err">${parsed.errors.length - 5} more problems not shown.</p>`);
  if (newHints.length) {
    msgs.push(`<label class="holiday"><input type="checkbox" id="paste-hint" ${keepHints() ? 'checked' : ''}> Everyone is off on ${esc(newHints.map((d) => fmtDate(d)).join(', '))}. Add as holidays.</label>`);
  }
  const rows = preview.members.map((m) => `<tr><td>${esc(m.name)}</td><td class="n">${fmtNum(m.leaveDays)}</td><td class="n">${fmtNum(m.available)}</td></tr>`).join('');
  msgs.push(`<div class="scroll"><table><thead><tr><th>Person</th><th class="n">Leave days</th><th class="n">Available</th></tr></thead><tbody>${rows}</tbody></table></div>`);

  out.innerHTML = msgs.join('');
  $('paste-hint')?.addEventListener('change', previewPaste);
  pasted = { members, newHints };
  apply.disabled = members.length === 0;
}

$('paste-form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'apply' || !pasted) { e.preventDefault(); return; }
  const fields = { members: pasted.members };
  if (pasted.newHints.length && $('paste-hint')?.checked) {
    fields.holidays = [...new Set([...client.state.holidays, ...pasted.newHints])].sort();
  }
  client.update(fields);
  $('paste-text').value = '';
  $('paste-preview').innerHTML = '';
  pasted = null;
  notice('Leave applied to the sprint.');
});

// ---------------------------------------------------------------- start
$('room-name').textContent = ROOM_ID;
render();
renderStatus('connecting');
client.connect();
