// The Claude connector: a Model Context Protocol server, so Claude can answer
// "what's on our list?" from the list itself. Streamable HTTP with plain JSON
// answers (no SSE), stateless, behind lib/oauth.js.
//
// The rule, the same as every screen: IT SHOWS WHAT THE PERSON WOULD SEE, AND
// NOTHING ELSE. It is handed a view the routes build with the very functions
// the app's own screens use (SP.visibleIn, itemWire), so a private item of
// Linnea's is as absent here as on Andrew's phone. And some rooms it never
// enters at all: the rose, today's question, and anybody's kitchen. Those have
// their own rules about who may know what, and "Claude asked" is not one of them.
//
// Read only. Every tool says so (readOnlyHint), and none of them writes.
//
// PURE: `handle(message, look)` takes one JSON-RPC message and a function that
// returns the caller's view, and returns the reply (or null for a notification).

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXT = 100000;   // claude.ai takes about 150k characters; stay well under

const STATUS = ['to_do', 'done', 'all'];
const KIND_IDS = ['activity', 'movie', 'show', 'place', 'recipe'];

const readOnly = (title) => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

const TOOLS = [
  {
    name: 'list_lists',
    title: 'Your lists',
    description: 'The Do With lists this person keeps with other people, each titled from their side '
      + '("to do with Linnea"), with who is in it and how many things are waiting in each kind '
      + '(activities, films, shows, places, recipes). Start here to find a list.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly('Your lists'),
  },
  {
    name: 'get_list_items',
    title: 'What’s on a list',
    description: 'The things on one list, or on every list if none is named: what each is, whose idea it was, '
      + 'who can see it, when it is planned for, where it is, where a film or show streams, notes, and — for '
      + 'things already done — when and who ticked them off. Defaults to what is still to do.',
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'string', maxLength: 200, description: 'A list id from list_lists, or words from its title or a person in it ("Linnea", "Ski trip"). Omit for every list.' },
        kind: { type: 'string', enum: KIND_IDS, description: 'Only this kind: activity, movie (films), show, place or recipe.' },
        status: { type: 'string', enum: STATUS, description: 'to_do (default), done, or all.' },
        query: { type: 'string', maxLength: 200, description: 'Only things whose title, notes, place or tags contain these words.' },
      },
      additionalProperties: false,
    },
    annotations: readOnly('What’s on a list'),
  },
  {
    name: 'coming_up',
    title: 'Coming up',
    description: 'Everything planned for a day, across every list, from today forward — and anything planned for a '
      + 'day that has passed but is not done yet.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 366, description: 'How far ahead to look. Default 60.' } },
      additionalProperties: false,
    },
    annotations: readOnly('Coming up'),
  },
];

/* ── words ──────────────────────────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// A calendar date, the way the app stores a plan: "2026-11-29" → "Sat 29 Nov".
function dayWords(date, today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const thisYear = today && today.slice(0, 4) === m[1];
  return `${DAYS[d.getUTCDay()]} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${thisYear ? '' : ` ${m[1]}`}`;
}
// An instant, as a date in the person's own zone.
function instantWords(ms, zone, today) {
  if (!Number.isFinite(ms)) return null;
  let date;
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    date = `${p.year}-${p.month}-${p.day}`;
  } catch (_) { date = new Date(ms).toISOString().slice(0, 10); }
  return dayWords(date, today);
}
const addDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const oneLine = (s, max) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const AGAIN = { soon: 'would go back: can’t wait', maybe: 'would go back: maybe someday', once: 'would go back: once was enough' };

function audience(it, list) {
  if (it.visibility === 'private') return 'only you can see this';
  if (it.visibility === 'public') return it.fromElsewhere ? null : 'open to everyone you share a list with';
  return null;   // shared, the default, is what a list IS — not worth a word on every line
}

function itemLines(it, list, v) {
  const kind = v.kindOf(it.kind);
  const bits = [];
  if (!list.byKind) bits.push(kind.label);
  const ideaName = it.ideaMine ? 'your idea' : it.ideaByName ? `${it.ideaByName}’s idea` : null;
  if (ideaName && list.others) bits.push(ideaName);
  const author = it.author && it.author.name;
  if (it.fromElsewhere && author) bits.push(`a standing wish of ${author}’s, from another list`);
  else if (!it.mine && author && it.ideaBy !== (it.author && it.author.id)) bits.push(`added by ${author}`);
  else if (it.mine && !it.ideaMine) bits.push('added by you');
  const who = audience(it, list);
  if (who) bits.push(who);
  const w = it.mod && it.mod.watch;
  if (w) {
    const year = w.year || (w.date && String(w.date).slice(0, 4));
    if (year) bits.push(String(year));
    const on = Array.isArray(w.providers) ? w.providers.map(p => p && p.name).filter(Boolean).slice(0, 4) : [];
    if (on.length) bits.push(`streaming on ${on.join(', ')}`);
  }
  const pr = it.progress;
  if (pr && pr.total && !it.done) {
    bits.push(pr.caughtUp ? `all caught up (${pr.seen} episodes)${pr.coming ? `, S${pr.coming.s} E${pr.coming.e} still to come` : ''}`
      : `watched ${pr.seen} of ${pr.total} episodes${pr.next ? `, next S${pr.next.s} E${pr.next.e}` : ''}`);
  }
  const pl = it.mod && it.mod.place;
  if (pl && pl.name) bits.push(`at ${[pl.name, pl.area].filter(Boolean).join(', ')}`);
  // What the weather does to it (lib/placefit.js), when it matters at all.
  const fit = it.weatherFit;
  if (fit && fit.matters && fit.why) bits.push(`weather: ${oneLine(fit.why, 160)}`);
  if (it.when && it.when.date) {
    bits.push(`planned for ${dayWords(it.when.date, v.today)}${it.when.time ? ` at ${it.when.time}` : ''}`
      + (it.plannedByName && !it.done ? ` by ${it.plannedBy === v.uid ? 'you' : it.plannedByName}` : ''));
  }
  if (it.done) {
    const when = instantWords(it.doneAt, v.zone, v.today);
    const by = it.doneBy === v.uid ? 'you' : it.doneByName;
    bits.push(`done${when ? ` ${when}` : ''}${by ? ` by ${by}` : ''}`);
    if (it.visit && AGAIN[it.visit.again]) bits.push(AGAIN[it.visit.again]);
  }
  const r = it.mod && it.mod.recipe;
  if (r) {
    const made = Array.isArray(it.cooked) ? it.cooked.length : 0;
    bits.push([r.site && `recipe from ${r.site}`, r.total && `${r.total} min`, made && `made ${made === 1 ? 'once' : `${made} times`}`].filter(Boolean).join(', ') || 'has a recipe');
  }
  if (Array.isArray(it.tags) && it.tags.length) bits.push(`tags: ${it.tags.slice(0, 6).join(', ')}`);
  const lines = [`• ${oneLine(it.title, 200)}${bits.length ? ` — ${bits.join(' · ')}` : ''}`];
  const link = it.mod && it.mod.link && it.mod.link.url;
  if (link) lines.push(`  link: ${oneLine(link, 300)}`);
  if (it.notes) lines.push(`  notes: ${oneLine(it.notes, 400)}`);
  if (it.visit && it.visit.memory) lines.push(`  what it was like: ${oneLine(it.visit.memory, 300)}`);
  return lines;
}

/* ── the tools ──────────────────────────────────────────────────────────── */

function pickLists(v, words) {
  if (!words) return { lists: v.lists };
  const w = String(words).trim().toLowerCase();
  const exact = v.lists.filter(l => l.id.toLowerCase() === w || l.title.toLowerCase() === w);
  if (exact.length) return { lists: exact };
  const some = v.lists.filter(l => l.title.toLowerCase().includes(w)
    || (l.name || '').toLowerCase().includes(w)
    || l.members.some(m => m.id !== v.uid && m.name.toLowerCase().includes(w)));
  if (some.length) return { lists: some };
  return { error: `No list matches “${oneLine(words, 60)}”. Your lists: ${v.lists.map(l => `${l.title} (id ${l.id})`).join('; ') || 'none yet'}.` };
}

function listLists(v) {
  if (!v.lists.length) return `${v.me} has no lists in Do With yet.`;
  const out = [`${v.me} has ${v.lists.length === 1 ? 'one list' : `${v.lists.length} lists`} in Do With.`, ''];
  for (const l of v.lists) {
    const others = l.members.filter(m => m.id !== v.uid).map(m => m.name);
    out.push(`• ${l.title} (id ${l.id}) — ${others.length ? `with ${others.join(', ')}` : 'just you'}`);
    const kinds = Object.entries(l.counts.byKind || {}).filter(([, n]) => n)
      .map(([k, n]) => `${v.kindOf(k).plural} ${n}`).join(', ');
    out.push(`  To do: ${l.counts.open}${kinds ? ` (${kinds})` : ''} · Done together: ${l.counts.done}`);
  }
  return out.join('\n');
}

function getItems(v, a) {
  const picked = pickLists(v, a.list);
  if (picked.error) return { error: picked.error };
  const status = a.status || 'to_do';
  const q = a.query ? String(a.query).toLowerCase().trim() : '';
  const out = [];
  let total = 0;
  for (const l of picked.lists) {
    let items = l.items.filter(it => (status === 'all' ? true : status === 'done' ? it.done : !it.done));
    if (a.kind) items = items.filter(it => it.kind === a.kind);
    if (q) {
      items = items.filter(it => [it.title, it.notes, it.mod && it.mod.place && it.mod.place.name, ...(it.tags || [])]
        .some(x => x && String(x).toLowerCase().includes(q)));
    }
    const label = status === 'done' ? 'done' : status === 'all' ? 'everything' : 'to do';
    out.push(`${l.title} — ${label}${a.kind ? `, ${v.kindOf(a.kind).plural.toLowerCase()} only` : ''}${q ? `, matching “${oneLine(a.query, 60)}”` : ''}: ${items.length}`);
    total += items.length;
    const ctx = { others: l.members.some(m => m.id !== v.uid), byKind: true };
    // By kind, in the app's own order; done things newest first, the rest newest first too.
    const order = v.kinds.map(k => k.id);
    const groups = new Map(order.map(k => [k, []]));
    for (const it of items.sort((x, y) => (x.done && y.done ? (y.doneAt || 0) - (x.doneAt || 0) : (y.createdAt || 0) - (x.createdAt || 0)))) {
      (groups.get(it.kind) || groups.get(order[0])).push(it);
    }
    for (const [k, list] of groups) {
      if (!list.length) continue;
      out.push('', `${v.kindOf(k).plural} (${list.length})`);
      for (const it of list) out.push(...itemLines(it, ctx, v));
    }
    out.push('');
  }
  if (!total && picked.lists.length > 1) return { text: `Nothing ${status === 'done' ? 'done' : 'to do'} on any list${q ? ` matching “${oneLine(a.query, 60)}”` : ''}.` };
  return { text: out.join('\n').trim() };
}

function comingUp(v, a) {
  const days = a.days || 60;
  const until = addDays(v.today, days);
  const rows = [];
  const seen = new Set();
  for (const l of v.lists) {
    for (const it of l.items) {
      if (it.done || !it.when || !it.when.date || it.when.date > until || seen.has(it.id)) continue;
      seen.add(it.id);   // a public wish shows in every list of its author's; once is enough here
      rows.push({ it, l });
    }
  }
  rows.sort((x, y) => (x.it.when.date + (x.it.when.time || '')).localeCompare(y.it.when.date + (y.it.when.time || '')));
  const late = rows.filter(r => r.it.when.date < v.today);
  const ahead = rows.filter(r => r.it.when.date >= v.today);
  const line = ({ it, l }) => `• ${dayWords(it.when.date, v.today)}${it.when.time ? ` ${it.when.time}` : ''} — ${oneLine(it.title, 200)}`
    + ` (${v.kindOf(it.kind).label.toLowerCase()} · ${l.title}${it.mod && it.mod.place && it.mod.place.name ? ` · at ${it.mod.place.name}` : ''})`;
  const out = [`Today is ${dayWords(v.today, v.today)}.`];
  out.push('', ahead.length ? `Planned in the next ${days} days (${ahead.length}):` : `Nothing planned in the next ${days} days.`);
  out.push(...ahead.map(line));
  if (late.length) out.push('', `Planned for a day that has passed, and not done yet (${late.length}):`, ...late.map(line));
  return out.join('\n');
}

/* ── the protocol ───────────────────────────────────────────────────────── */

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
const textResult = (text, isError = false) => {
  const t = String(text);
  const clipped = t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n\n[…cut short: ask for one list, one kind, or a query]` : t;
  return { content: [{ type: 'text', text: clipped }], ...(isError ? { isError: true } : {}) };
};

function args(tool, raw) {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const props = tool.inputSchema.properties;
  for (const k of Object.keys(a)) if (!props[k]) return { error: `Unknown argument “${k}”.` };
  const out = {};
  for (const [k, p] of Object.entries(props)) {
    const v = a[k];
    if (v === undefined || v === null || v === '') continue;
    if (p.type === 'string') {
      if (typeof v !== 'string' || v.length > (p.maxLength || 200)) return { error: `${k} should be text.` };
      if (p.enum && !p.enum.includes(v)) return { error: `${k} is one of: ${p.enum.join(', ')}.` };
      out[k] = v;
    } else if (p.type === 'integer') {
      if (!Number.isInteger(v) || v < p.minimum || v > p.maximum) return { error: `${k} is a whole number from ${p.minimum} to ${p.maximum}.` };
      out[k] = v;
    }
  }
  return { args: out };
}

function handle(msg, look) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // A response or something unreadable. Responses to us are not expected; say
    // nothing to them, and a malformed request gets the standard error.
    return msg && msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)
      ? null : fail(msg && msg.id, -32600, 'Invalid request');
  }
  const { id, method, params } = msg;
  if (id === undefined) return null;   // a notification: notifications/initialized and the like
  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      const v = look();
      return ok(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dowith', title: 'Do With', version: '1.0.0' },
        instructions: `Do With holds ${v.me}'s lists of things to do with other people — films and shows to watch, `
          + `places to go, recipes to cook, things to do together. Each list is titled from ${v.me}'s side ("to do with Linnea"). `
          + 'These tools read exactly what they can see in the app, and change nothing. Use list_lists first, then get_list_items or coming_up.',
      });
    }
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: TOOLS });
    case 'resources/list': return ok(id, { resources: [] });
    case 'resources/templates/list': return ok(id, { resourceTemplates: [] });
    case 'prompts/list': return ok(id, { prompts: [] });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === (params && params.name));
      if (!tool) return fail(id, -32602, `Unknown tool: ${params && params.name}`);
      const got = args(tool, params.arguments);
      if (got.error) return ok(id, textResult(got.error, true));
      const v = look();
      if (tool.name === 'list_lists') return ok(id, textResult(listLists(v)));
      if (tool.name === 'coming_up') return ok(id, textResult(comingUp(v, got.args)));
      const r = getItems(v, got.args);
      return ok(id, r.error ? textResult(r.error, true) : textResult(r.text));
    }
    default: return fail(id, -32601, `Method not found: ${method}`);
  }
}

module.exports = { VERSIONS, TOOLS, handle, dayWords, MAX_TEXT };
