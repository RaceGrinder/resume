/* ============================================================
   Book a Call — slot picker for Race Grinder's site
   Availability = working hours minus busy blocks in busy.json
   (busy.json is refreshed from iCloud by .github/workflows/sync-calendar.yml)
   ============================================================ */

const CONFIG = {
  ownerName: 'Race Grinder',
  notifyEmail: 'grindere@mail.uc.edu',  // where booking emails go (via FormSubmit)
  zoomLink: 'https://us05web.zoom.us/j/9971995904?pwd=f8MImV4oOPYJw6KvABnbKb7QRmWbOp.1',                         // your Zoom personal meeting link

  homeTz: 'America/New_York',
  workDays: [1, 2, 3, 4, 5],            // Mon–Fri
  startHour: 10,                        // 10:00 ET
  endHour: 18,                          // last call ends by 18:00 ET
  slotMinutes: 30,
  minNoticeHours: 4,                    // no bookings sooner than this
  daysAhead: 21                         // how far out people can book
};

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const visitorTz = Intl.DateTimeFormat().resolvedOptions().timeZone || CONFIG.homeTz;

/* ---------- Time-zone helpers (no libraries) ---------- */

function partsIn(date, tz) {
  const out = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).forEach((p) => { out[p.type] = p.value; });
  return out;
}

function offsetMinutes(date, tz) {
  const p = partsIn(date, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUtc - date.getTime()) / 60000;
}

// Wall-clock time in `tz` -> real instant
function zonedToDate(y, m, d, h, min, tz) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - offsetMinutes(new Date(guess), tz) * 60000;
  const second = guess - offsetMinutes(new Date(t), tz) * 60000;
  if (second !== t) t = second;
  return new Date(t);
}

const fmt = (date, opts, tz = visitorTz) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(date);

const tzAbbr = (date, tz) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || tz;

/* ---------- Building the day + slot list ---------- */

let busy = [];
let days = [];          // [{ key, y, m, d, dow, slots: [Date] }]
let weekIndex = 0;
let selectedDayKey = null;
let selectedSlot = null;

function localBooked() {
  try { return JSON.parse(localStorage.getItem('rg-booked') || '[]'); } catch { return []; }
}
function rememberBooked(iso) {
  try {
    const keep = localBooked().filter((s) => new Date(s) > new Date());
    keep.push(iso);
    localStorage.setItem('rg-booked', JSON.stringify(keep));
  } catch { /* storage unavailable: fine */ }
}

function buildDays() {
  const now = new Date();
  const earliest = now.getTime() + CONFIG.minNoticeHours * 3600000;
  const today = partsIn(now, CONFIG.homeTz);
  const booked = localBooked().map((s) => new Date(s).getTime());
  const out = [];

  for (let i = 0; i <= CONFIG.daysAhead; i++) {
    const cal = new Date(Date.UTC(+today.year, +today.month - 1, +today.day + i));
    const y = cal.getUTCFullYear(), m = cal.getUTCMonth() + 1, d = cal.getUTCDate();
    const dow = cal.getUTCDay();
    const day = { key: `${y}-${pad(m)}-${pad(d)}`, y, m, d, dow, work: CONFIG.workDays.includes(dow), slots: [] };

    if (day.work) {
      for (let mins = CONFIG.startHour * 60; mins + CONFIG.slotMinutes <= CONFIG.endHour * 60; mins += CONFIG.slotMinutes) {
        const start = zonedToDate(y, m, d, Math.floor(mins / 60), mins % 60, CONFIG.homeTz);
        const s = start.getTime();
        const e = s + CONFIG.slotMinutes * 60000;
        if (s < earliest) continue;
        if (booked.includes(s)) continue;
        if (busy.some((b) => s < b.end && e > b.start)) continue;
        day.slots.push(start);
      }
    }
    out.push(day);
  }
  return out;
}

// Group the window into Mon–Fri weeks
function weeks() {
  const groups = [];
  let current = null;
  days.forEach((day) => {
    if (!day.work) return;
    if (!current || day.dow === 1 || (current.length && day.dow < current[current.length - 1].dow)) {
      current = [];
      groups.push(current);
    }
    current.push(day);
  });
  return groups;
}

/* ---------- Rendering ---------- */

function dateOfDay(day) {
  return zonedToDate(day.y, day.m, day.d, 12, 0, CONFIG.homeTz);
}

function renderWeek() {
  const ws = weeks();
  weekIndex = Math.max(0, Math.min(weekIndex, ws.length - 1));
  const week = ws[weekIndex] || [];

  $('prev-week').disabled = weekIndex === 0;
  $('next-week').disabled = weekIndex >= ws.length - 1;

  if (week.length) {
    const first = dateOfDay(week[0]);
    const last = dateOfDay(week[week.length - 1]);
    const sameMonth = week[0].m === week[week.length - 1].m;
    $('week-label').textContent = sameMonth
      ? `${fmt(first, { month: 'long' }, CONFIG.homeTz)} ${week[0].d}–${week[week.length - 1].d}`
      : `${fmt(first, { month: 'short', day: 'numeric' }, CONFIG.homeTz)} – ${fmt(last, { month: 'short', day: 'numeric' }, CONFIG.homeTz)}`;
  }

  const strip = $('day-strip');
  strip.innerHTML = '';
  // Keep Mon–Fri columns aligned even when the week is partial
  const firstDow = week.length ? week[0].dow : 1;
  for (let i = 1; i < firstDow; i++) {
    const spacer = document.createElement('span');
    spacer.className = 'day-btn day-empty';
    spacer.setAttribute('aria-hidden', 'true');
    strip.appendChild(spacer);
  }

  week.forEach((day) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-btn';
    const open = day.slots.length;
    btn.disabled = !open;
    btn.setAttribute('aria-pressed', String(day.key === selectedDayKey));
    const date = dateOfDay(day);
    btn.innerHTML =
      `<span class="day-dow">${fmt(date, { weekday: 'short' }, CONFIG.homeTz)}</span>` +
      `<span class="day-num">${day.d}</span>` +
      `<span class="day-count">${open ? `${open} open` : 'Full'}</span>`;
    btn.addEventListener('click', () => { selectedDayKey = day.key; renderWeek(); renderSlots(); });
    strip.appendChild(btn);
  });

  // Auto-select the first open day in this week
  if (!week.some((d) => d.key === selectedDayKey && d.slots.length)) {
    const firstOpen = week.find((d) => d.slots.length);
    if (firstOpen) { selectedDayKey = firstOpen.key; renderWeek(); return; }
    selectedDayKey = null;
  }
  renderSlots();
}

function renderSlots() {
  const grid = $('slot-grid');
  grid.innerHTML = '';
  const day = days.find((d) => d.key === selectedDayKey);

  if (!day) {
    $('slot-heading').textContent = 'No open times this week — try the next one.';
    return;
  }
  $('slot-heading').textContent = fmt(dateOfDay(day), { weekday: 'long', month: 'long', day: 'numeric' }, CONFIG.homeTz);

  day.slots.forEach((slot) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot-btn';
    btn.textContent = fmt(slot, { hour: 'numeric', minute: '2-digit' });
    btn.addEventListener('click', () => chooseSlot(slot));
    grid.appendChild(btn);
  });
}

function whenText(slot, tz) {
  const end = new Date(slot.getTime() + CONFIG.slotMinutes * 60000);
  return `${fmt(slot, { weekday: 'long', month: 'long', day: 'numeric' }, tz)}, ` +
    `${fmt(slot, { hour: 'numeric', minute: '2-digit' }, tz)}–${fmt(end, { hour: 'numeric', minute: '2-digit' }, tz)} ${tzAbbr(slot, tz)}`;
}

function chooseSlot(slot) {
  selectedSlot = slot;
  $('picked-summary').innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>` +
    `<span>${whenText(slot, visitorTz)}</span>`;
  $('step-pick').hidden = true;
  $('step-details').hidden = false;
  $('form-error').hidden = true;
  $('booker').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('f-name').focus({ preventScroll: true }), 350);
}

/* ---------- Calendar files ---------- */

const icsStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEscape = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function icsFile({ start, title, description, location = CONFIG.zoomLink }) {
  const end = new Date(start.getTime() + CONFIG.slotMinutes * 60000);
  const body = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Race Grinder//Book a Call//EN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsStamp(start)}-${Math.random().toString(36).slice(2)}@racegrinder`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(title)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    ...(location ? [`LOCATION:${icsEscape(location)}`, `URL:${location}`] : []),
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  return URL.createObjectURL(new Blob([body], { type: 'text/calendar;charset=utf-8' }));
}

function gcalLink(start, title, details) {
  const end = new Date(start.getTime() + CONFIG.slotMinutes * 60000);
  const q = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${icsStamp(start)}/${icsStamp(end)}`, details });
  if (CONFIG.zoomLink) q.set('location', CONFIG.zoomLink);
  return `https://calendar.google.com/calendar/render?${q}`;
}

// Link included in Race's notification email: opens this page and offers an .ics
function ownerAddLink(info) {
  const json = JSON.stringify(info);
  const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}#add=${b64}`;
}

function readOwnerLink() {
  const m = location.hash.match(/^#add=([\w-]+)$/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch { return null; }
}

/* ---------- Submitting ---------- */

async function submitBooking(e) {
  e.preventDefault();
  const name = $('f-name').value.trim();
  const email = $('f-email').value.trim();
  const topic = $('f-topic').value.trim();
  const err = $('form-error');

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    err.textContent = 'Please add your name and a valid email.';
    err.hidden = false;
    return;
  }
  err.hidden = true;

  const slot = selectedSlot;
  const btn = $('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Booking…';

  // Bots fill the hidden field; quietly "succeed" without sending anything
  if ($('f-honey').value) { showDone(slot); return; }

  const addLink = ownerAddLink({ s: slot.toISOString(), n: name, e: email, t: topic.slice(0, 300) });
  const whenEt = whenText(slot, CONFIG.homeTz);
  const payload = {
    _subject: `New call booked: ${name} — ${whenEt}`,
    _template: 'table',
    _captcha: 'false',
    Name: name,
    email,
    'When (Eastern)': whenEt,
    'When (their time)': visitorTz === CONFIG.homeTz ? 'Same' : whenText(slot, visitorTz),
    Topic: topic || '—',
    ...(CONFIG.zoomLink ? { Zoom: CONFIG.zoomLink } : {}),
    'Add to your calendar': addLink
  };

  try {
    const res = await fetch(`https://formsubmit.co/ajax/${CONFIG.notifyEmail}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || String(data.success) === 'false') throw new Error(data.message || 'send failed');
    rememberBooked(slot.toISOString());
    showDone(slot);
  } catch {
    const mail = `mailto:${CONFIG.notifyEmail}?subject=${encodeURIComponent(payload._subject)}` +
      `&body=${encodeURIComponent(`Hi Race,\n\nI'd like to book ${whenEt}.\n\nName: ${name}\nEmail: ${email}\nTopic: ${topic}`)}`;
    err.innerHTML = `Something went wrong sending your booking. <a href="${mail}">Email it to me instead</a> and I&rsquo;ll lock it in.`;
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Confirm Booking';
  }
}

function showDone(slot) {
  const title = `Call with ${CONFIG.ownerName}`;
  const details = [
    `30-minute Zoom call with ${CONFIG.ownerName}.`,
    CONFIG.zoomLink ? `Join: ${CONFIG.zoomLink}` : '',
    `Questions? ${CONFIG.notifyEmail}`
  ].filter(Boolean).join('\n');
  $('done-when').textContent = whenText(slot, visitorTz);
  if (CONFIG.zoomLink) {
    $('done-zoom').href = CONFIG.zoomLink;
    $('done-zoom').hidden = false;
    $('done-zoom-note').hidden = false;
  }
  const ics = $('done-ics');
  ics.href = icsFile({ start: slot, title, description: details });
  ics.download = 'call-with-race-grinder.ics';
  $('done-gcal').href = gcalLink(slot, title, details);
  $('step-details').hidden = true;
  $('step-done').hidden = false;
  $('booker').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- Owner view (from the email link) ---------- */

function showOwnerAdd(info) {
  const start = new Date(info.s);
  if (isNaN(start)) return;
  $('owner-add').hidden = false;
  $('owner-add-title').textContent = `Call with ${info.n}`;
  $('owner-add-detail').textContent = `${whenText(start, CONFIG.homeTz)} · ${info.e}`;
  const btn = $('owner-add-btn');
  btn.href = icsFile({
    start,
    title: `Call with ${info.n}`,
    description: [`Booked through your site`, `Email: ${info.e}`, info.t ? `Topic: ${info.t}` : '', CONFIG.zoomLink ? `Zoom: ${CONFIG.zoomLink}` : ''].filter(Boolean).join('\n')
  });
  btn.download = `call-with-${String(info.n).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ics`;
}

/* ---------- Start up ---------- */

async function init() {
  const owner = readOwnerLink();
  if (owner) showOwnerAdd(owner);

  const sample = new Date();
  $('tz-note').textContent = visitorTz === CONFIG.homeTz
    ? `Times shown in Eastern Time (${tzAbbr(sample, visitorTz)}).`
    : `Times shown in your time zone (${tzAbbr(sample, visitorTz)}). I'm on Eastern Time.`;

  try {
    const res = await fetch('busy.json', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const data = await res.json();
    busy = (data.busy || []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
  } catch {
    $('slot-heading').innerHTML = `Couldn&rsquo;t load my availability right now. ` +
      `<a href="mailto:${CONFIG.notifyEmail}">Email me</a> and we&rsquo;ll find a time.`;
    $('prev-week').disabled = $('next-week').disabled = true;
    return;
  }

  days = buildDays();
  renderWeek();

  $('prev-week').addEventListener('click', () => { weekIndex--; selectedDayKey = null; renderWeek(); });
  $('next-week').addEventListener('click', () => { weekIndex++; selectedDayKey = null; renderWeek(); });
  $('change-time').addEventListener('click', () => {
    $('step-details').hidden = true;
    $('step-pick').hidden = false;
  });
  $('step-details').addEventListener('submit', submitBooking);
}

init();
