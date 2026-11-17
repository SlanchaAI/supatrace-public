// Status page: two live checks from the visitor's browser, plus the optional /status.json feed.
// API requests from this page are retried when the service is momentarily busy (see app/request-queue.js).
import '../app/request-queue.js';
import {readFeed} from './feed.js';

const el = (tag, className, textContent) => { const node = document.createElement(tag); if (className) node.className = className; if (textContent) node.textContent = textContent; return node; };
const pill = (state, label) => el('span', 'status ' + ({operational: 'available', reachable: 'available', degraded: 'beta', stale: 'beta', outage: 'down', unreachable: 'down'}[state] || 'planned'), label || state);
const when = iso => new Date(iso).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});

async function check(id, run) {
  const row = document.getElementById(id), slot = row.querySelector('.state'), note = row.querySelector('.note');
  try {
    const detail = await run();
    slot.replaceChildren(pill('reachable'));
    note.textContent = detail;
  } catch {
    slot.replaceChildren(pill('unreachable'));
    note.textContent = 'This browser could not reach it just now.';
  }
}
const get = async path => {
  const response = await fetch(path, {cache: 'no-store', signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error('status ' + response.status);
  return response.json();
};

check('check-site', async () => {
  const build = await get('/build.json');
  return typeof build.commit === 'string' ? 'Serving build ' + build.commit.slice(0, 7) + '.' : 'Static site answered. This deployment has no build marker.';
});
check('check-api', async () => {
  const providers = await get('/api/auth/providers');
  if (typeof providers.github !== 'boolean') throw new Error('unexpected body');
  return 'The API answered a public request.';
});
document.getElementById('checked-at').textContent = 'Checked from your browser at ' + new Date().toLocaleTimeString() + '.';

const feedBox = document.getElementById('feed'), incidentsBox = document.getElementById('incidents');
const noFeed = [...feedBox.childNodes].map(node => node.cloneNode(true)), noIncidents = [...incidentsBox.childNodes].map(node => node.cloneNode(true));

function render(feed) {
  feedBox.replaceChildren(...noFeed.map(node => node.cloneNode(true)));
  incidentsBox.replaceChildren(...noIncidents.map(node => node.cloneNode(true)));
  if (feed.kind === 'none') return;
  feedBox.replaceChildren();
  if (feed.kind === 'invalid') { feedBox.append(el('p', '', 'A status feed is published but could not be read, so no monitored status is shown.')); return; }
  const head = el('p', 'feed-head');
  if (feed.kind === 'stale') head.append(pill('stale'), ' The monitoring feed was last updated ' + when(feed.updated_at) + '. It is out of date, so it does not describe the current state.');
  else head.append(pill(feed.overall), ' Monitoring feed updated ' + when(feed.updated_at) + '.');
  const list = el('ul', 'components');
  for (const item of feed.components) {
    const row = el('li');
    row.append(el('strong', '', item.name), feed.kind === 'stale' ? pill('stale', 'last known: ' + item.status) : pill(item.status));
    if (item.note) row.append(el('span', 'note', item.note));
    list.append(row);
  }
  feedBox.append(head, list);
  if (!feed.incidents.length) return;
  incidentsBox.replaceChildren();
  for (const item of feed.incidents) {
    const entry = el('li');
    entry.append(el('strong', '', item.title), el('span', 'note', when(item.started_at) + (item.resolved_at ? ' to ' + when(item.resolved_at) + ' (resolved)' : ' (ongoing)')));
    if (item.body) entry.append(el('p', '', item.body));
    incidentsBox.append(entry);
  }
}

// What is on screen is always the last fetched feed classified against the current time.
// Classification does not wait for the network: every few seconds, and the moment the tab
// becomes visible, the cached feed is classified again, so "operational" disappears when the
// feed ages out even if the next fetch is slow or never completes. Separately the feed is
// fetched again every minute.
let last = null, shown = '';
function show() {
  const feed = last === undefined ? {kind: 'invalid'} : last === null ? {kind: 'none'} : readFeed(last);
  // The whole fetched feed is part of the key: any change in content renders again.
  const key = feed.kind + '|' + JSON.stringify(last ?? null);
  if (key === shown) return;
  shown = key;
  render(feed);
}
// Refreshes can overlap (timer plus tab visibility). Only the most recently started request
// may update what is shown, so a slow older response can never replace a newer one.
let generation = 0;
async function refresh() {
  const mine = ++generation;
  let result;
  try { result = await get('/status.json'); } catch { result = undefined; }
  if (mine !== generation) return;
  last = result;
  show();
}
refresh();
setInterval(show, 5000);
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { show(); refresh(); } });
