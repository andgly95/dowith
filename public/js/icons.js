// The icons. One set, drawn to one spec: 24-unit box, round caps and joins, no
// fills. That consistency is the whole job at these sizes — icons from five
// drawing conventions read as five mistakes.
//
// Kind icons are keyed by kind id. Presentation, so they live here rather than
// in the kinds table — the server owns the vocabulary, the client owns how it
// looks — and a kind added without one falls back to a plain mark rather than
// to a hole.

const KIND = {
  // A spark. The app's own flourish when you finish something is sparks, so the
  // kind that means "something to do together" borrows it.
  activity: '<path d="M12 3.5l1.7 5.1a2 2 0 0 0 1.3 1.3l5.1 1.7-5.1 1.7a2 2 0 0 0-1.3 1.3L12 19.8l-1.7-5.2a2 2 0 0 0-1.3-1.3L3.9 11.6l5.1-1.7a2 2 0 0 0 1.3-1.3z"/>',
  // A strip of film. The sprockets are FILLED squares rather than more stroked
  // lines: at 23px a third and fourth hairline inside an 18px box turns to
  // mush, and the first attempt read as a book with two pages.
  movie: '<rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2.4"/>'
    + '<path d="M7.4 4.8v14.4M16.6 4.8v14.4"/>'
    + '<g fill="currentColor" stroke="none">'
    + '<rect x="4.6" y="7.4" width="1.6" height="1.6" rx=".4"/>'
    + '<rect x="4.6" y="11.2" width="1.6" height="1.6" rx=".4"/>'
    + '<rect x="4.6" y="15" width="1.6" height="1.6" rx=".4"/>'
    + '<rect x="17.8" y="7.4" width="1.6" height="1.6" rx=".4"/>'
    + '<rect x="17.8" y="11.2" width="1.6" height="1.6" rx=".4"/>'
    + '<rect x="17.8" y="15" width="1.6" height="1.6" rx=".4"/>'
    + '</g>',
  // A set with its ears up.
  show: '<rect x="3.2" y="7.6" width="17.6" height="11.6" rx="2.4"/><path d="M8.4 3.6L12 7.6l3.6-4"/>',
  // A pin.
  place: '<path d="M12 20.8s6.6-5.4 6.6-10.1a6.6 6.6 0 1 0-13.2 0C5.4 15.4 12 20.8 12 20.8z"/><circle cx="12" cy="10.5" r="2.4"/>',
  // A pot, steaming.
  recipe: '<path d="M4.4 10.2h15.2v4.6a4 4 0 0 1-4 4H8.4a4 4 0 0 1-4-4z"/><path d="M2.9 10.2h18.2"/><path d="M9 7.4c0-1.1 1-1.5 1-2.6M12.6 7.4c0-1.1 1-1.5 1-2.6"/>',
};
const FALLBACK = '<circle cx="12" cy="12" r="6.4"/>';

export const iconFor = (id, size = 23) => `<svg viewBox="0 0 24 24" aria-hidden="true" width="${size}" height="${size}"
  fill="none" stroke="currentColor" stroke-width="1.6"
  stroke-linecap="round" stroke-linejoin="round">${KIND[id] || FALLBACK}</svg>`;

const UI = {
  check: '<circle cx="12" cy="12" r="8.6"/><path d="M8.2 12.3l2.6 2.6 5-5.2"/>',
  tick: '<path d="M5.5 12.4l4.3 4.3L18.6 7.6"/>',
  pin: KIND.place,
  lock: '<rect x="5.6" y="10.6" width="12.8" height="9.4" rx="2.2"/><path d="M8.6 10.6V8.2a3.4 3.4 0 0 1 6.8 0v2.4"/>',
  people: '<circle cx="9" cy="8.8" r="3.2"/><path d="M3.4 19.2c.6-3 2.9-4.7 5.6-4.7s5 1.7 5.6 4.7"/><circle cx="16.6" cy="9.4" r="2.6"/><path d="M15.6 14.4c2.5 0 4.4 1.4 5 4"/>',
  globe: '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2M12 3.4c2.4 2.6 3.6 5.5 3.6 8.6s-1.2 6-3.6 8.6c-2.4-2.6-3.6-5.5-3.6-8.6s1.2-6 3.6-8.6z"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.6V12l3 2"/>',
  cal: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  chev: '<path d="M9 5.5l6.5 6.5L9 18.5"/>',
  phone: '<path d="M6.5 4.5h3l1.5 4-2 1.3a10 10 0 0 0 5.2 5.2l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.7a2 2 0 0 1 2-2.2z"/>',
  list: '<path d="M4 7l1.6 1.6L8.4 5.8M4 15.5l1.6 1.6 2.8-2.8"/><path d="M11.5 7.2h8.5M11.5 16h8.5"/>',
  basket: '<path d="M3.6 10h16.8l-1.7 8.4a2 2 0 0 1-2 1.6H7.3a2 2 0 0 1-2-1.6z"/><path d="M8.4 10l3.6-6 3.6 6M9.4 13.6v3M14.6 13.6v3"/>',
  minus: '<path d="M5.5 12h13"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  timer: '<circle cx="12" cy="13.2" r="7.2"/><path d="M12 9.6v3.8l2.4 1.4M9.6 3.4h4.8"/>',
  // Two arrows passing: one thing in place of another.
  swap: '<path d="M4.5 8.5h13.5M14.6 5l3.5 3.5-3.5 3.5M19.5 15.5H6M9.4 12L5.9 15.5 9.4 19"/>',
  spark: '<path d="M12 4.2l1.5 4.4a2 2 0 0 0 1.2 1.2l4.4 1.5-4.4 1.5a2 2 0 0 0-1.2 1.2L12 18.4l-1.5-4.4a2 2 0 0 0-1.2-1.2l-4.4-1.5 4.4-1.5a2 2 0 0 0 1.2-1.2z"/>',
  // Today's question: a speech bubble asking, a flame for the streak.
  ask: '<path d="M5.2 17.4A8 8 0 1 1 8 19.6l-3.6 1 .8-3.2z"/><path d="M10.2 9.6a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.3M12 15.4v.1"/>',
  flame: '<path d="M12 20.5c3.4 0 6-2.4 6-5.8 0-3.6-2.6-5.6-3.6-8.8-.4 1.8-1.2 3-2.4 3.8.2-2.6-.6-4.8-2.2-6.2.2 3.4-3.8 5.6-3.8 11.2 0 3.4 2.6 5.8 6 5.8z"/><path d="M12 20.5c-1.5 0-2.6-1.1-2.6-2.6 0-1.9 1.6-2.6 2-4.4.9.9 1.5 1.6 1.8 2.4.4-.4.7-.9.8-1.4.7.9 1 1.8 1 2.8 0 1.9-1.4 3.2-3 3.2z"/>',
  heart: '<path d="M12 19.6s-7.2-4.3-7.2-9.5A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.2 2.5c0 5.2-7.2 9.5-7.2 9.5z"/>',
  bell: '<path d="M6.2 16.6V11a5.8 5.8 0 0 1 11.6 0v5.6l1.4 1.6H4.8zM10 20.2a2.2 2.2 0 0 0 4 0"/>',
  book: '<path d="M5 5.2A2 2 0 0 1 7 3.6h12v14.6H7a2 2 0 0 0-2 2z"/><path d="M5 20.2a2 2 0 0 1 2-2h12v2.2H7"/>',
  send: '<path d="M4.6 12L19.4 5l-4.2 14.2-3.4-5.8z"/><path d="M11.8 13.4L19.4 5"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  rose: '<path d="M7 5.2c0 3.3 2.2 5.8 5 5.8s5-2.5 5-5.8c-1.4.9-2.7.9-3.6 0-.6-.6-1-1.5-1.4-2.7-.4 1.2-.8 2.1-1.4 2.7-.9.9-2.2.9-3.6 0z"/><path d="M9.8 6.9c.6.8 1.4 1.2 2.2 1.2s1.6-.4 2.2-1.2"/><path d="M12 11v10"/><path d="M12 16.2c-1.9-.2-3.5-1.3-4.1-3.2 2 0 3.5 1 4.1 3.2z"/><path d="M12 18.6c1.9-.2 3.5-1.3 4.1-3.2-2 0-3.5 1-4.1 3.2z"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.6 7l.9 12.2h9L17.4 7M10.2 10.6v5.4M13.8 10.6v5.4"/>',
  pencil: '<path d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10z"/><path d="M13.2 6.8l4 4"/>',
  link: '<path d="M10.2 13.8a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.1 1.1"/><path d="M13.8 10.2a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.1-1.1"/>',
  play: '<path d="M8 5.6v12.8L18.4 12z"/>',
  pause: '<path d="M8.6 5.6v12.8M15.4 5.6v12.8"/>',
  back: '<path d="M19 12H5.5M11 6l-6 6 6 6"/>',
  next: '<path d="M5 12h13.5M13 6l6 6-6 6"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3.5v1.8M12 18.7v1.8M3.5 12h1.8M18.7 12h1.8M6 6l1.3 1.3M16.7 16.7L18 18M6 18l1.3-1.3M16.7 7.3L18 6"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  share: '<path d="M12 14.6V3.8M8.2 7.4L12 3.8l3.8 3.6"/><path d="M7 10.6H5.8v9h12.4v-9H17"/>',
};

export const icon = (name, size = 20, sw = 1.8) => `<svg viewBox="0 0 24 24" aria-hidden="true" width="${size}" height="${size}"
  fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${UI[name] || FALLBACK}</svg>`;
