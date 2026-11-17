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
};

export const icon = (name, size = 20, sw = 1.8) => `<svg viewBox="0 0 24 24" aria-hidden="true" width="${size}" height="${size}"
  fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${UI[name] || FALLBACK}</svg>`;
