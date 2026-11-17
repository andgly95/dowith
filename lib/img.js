// Images, kept here rather than hotlinked.
//
// Do With hosted no images before recipes. Hotlinking a recipe site's photo
// would hand every viewer's IP to that site on every render and break the day
// they move it, so a read downloads the image ONCE and keeps it:
//
//   · image/* only, 2 MB cap (lib/fetchpage.js enforces both);
//   · the type SNIFFED from the first bytes — JPEG, PNG, WebP — never trusted
//     from a header, because the bytes are what a browser will decode;
//   · content-addressed, `data/img/<first 24 hex of sha256>.<ext>`, so the same
//     photo is stored once however many items use it;
//   · served behind the sign-in guard, immutable, by `GET /api/img/:name`;
//   · swept daily of anything no item references and older than a day (a read
//     that was never saved leaves one behind).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 2 * 1024 * 1024;
const NAME = /^[a-f0-9]{24}\.(jpg|png|webp)$/;
const DIR = () => path.join(path.dirname(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'store.json')), 'img');

function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

// Keep it; returns its name, or null when it is not an image we take.
function save(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length || buf.length > MAX_BYTES) return null;
  const ext = sniff(buf);
  if (!ext) return null;
  const name = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)}.${ext}`;
  const dir = DIR();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  return name;
}

const valid = (name) => NAME.test(String(name || ''));
const pathOf = (name) => (valid(name) ? path.join(DIR(), name) : null);

// Everything no item points at, older than a day, goes.
function sweep(referenced, { now = Date.now(), minAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  let gone = 0;
  let names = [];
  try { names = fs.readdirSync(DIR()); } catch (_) { return 0; }
  for (const n of names) {
    if (!valid(n) || referenced.has(n)) continue;
    const f = path.join(DIR(), n);
    try {
      if (now - fs.statSync(f).mtimeMs < minAgeMs) continue;
      fs.unlinkSync(f);
      gone++;
    } catch (_) { /* gone already */ }
  }
  return gone;
}

module.exports = { MAX_BYTES, NAME, sniff, save, valid, pathOf, sweep, DIR };
