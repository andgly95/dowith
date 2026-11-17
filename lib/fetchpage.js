// The ONE place this server fetches a URL somebody typed.
//
// A server that fetches arbitrary URLs on request is how an app gets used to
// probe the network it sits on — the router's admin page, the Pi's own ports,
// the cloud metadata address. So every guard is here and nowhere else:
//
//   · http and https only, no credentials in the URL;
//   · at most 4 redirects, EACH ONE re-checked;
//   · 8 seconds, a size cap streamed and enforced (aborted past it, never
//     buffered and then measured), and the content type checked;
//   · and the address refused AT CONNECT TIME. The Square checks the name
//     before fetching, which leaves a DNS-rebinding gap: the name can resolve
//     to a public address for the check and a private one for the connection.
//     Here the check is the `lookup` the socket itself uses, so the address
//     checked is the address connected to. An IP literal never goes through
//     `lookup`, so literals are checked before the request.
//
// PREVIEW_ALLOW_PRIVATE=1 is for the test suite only, so it can serve a fixture
// page from localhost — the same switch The Square uses.

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');

const UA = 'DoWith/1.0 (+https://dowith.guess-ai.app)';
const MAX_HOPS = 4;
const TIMEOUT_MS = 8000;

function v4Private(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)          // CGNAT 100.64/10
    || (a === 169 && b === 254)                    // link-local, and the metadata address
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)                      // 192.0.0/24, 192.0.2/24
    || (a === 198 && (b === 18 || b === 19))       // benchmarking
    || a >= 224;                                   // multicast and reserved
}

// Loopback, RFC 1918, link-local, CGNAT, ULA, unspecified, multicast — and the
// IPv4-mapped and NAT64 IPv6 forms of all of the v4 ones, which is the usual
// way round a check that only looks at v4.
function privateAddr(ip) {
  const s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIPv4(s)) return v4Private(s);
  if (!net.isIPv6(s)) return true;
  if (s === '::' || s === '::1') return true;
  const mapped = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return v4Private(mapped[1]);
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return v4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (/^::ffff:/.test(s)) return true;
  if (/^f[cd]/.test(s)) return true;                // ULA fc00::/7
  if (/^fe[89ab]/.test(s)) return true;             // link-local fe80::/10
  if (/^ff/.test(s)) return true;                   // multicast
  return false;
}

const allowPrivateEnv = () => process.env.PREVIEW_ALLOW_PRIVATE === '1';

// The lookup the socket uses. Whatever the name resolves to, every address is
// checked, and one private answer refuses the lot.
function guardedLookup(allow) {
  return (hostname, opts, cb) => {
    const o = typeof opts === 'object' && opts ? opts : { family: opts };
    dns.lookup(hostname, { ...o, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [];
      if (!list.length) return cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }));
      if (list.some(a => !allow(a.address))) {
        return cb(Object.assign(new Error('refused: private address'), { code: 'EREFUSED_PRIVATE' }));
      }
      if (o.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

class Refused extends Error { constructor(why) { super(why); this.why = why; } }

function checkUrl(raw, allow) {
  let u;
  try { u = new URL(raw); } catch (_) { throw new Refused('refused'); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Refused('refused');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !allow(host)) throw new Refused('refused');
  return u;
}

function once(u, { accept, maxBytes, allow }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      lookup: guardedLookup(allow),
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en', 'Accept-Encoding': 'gzip, deflate, br' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, u).href });
      }
      if (status < 200 || status >= 300) { res.resume(); return reject(new Refused('unreachable')); }
      const len = Number(res.headers['content-length'] || 0);
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (!enc && len > maxBytes) { res.destroy(); return reject(new Refused('too-big')); }
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(); stream.destroy(); reject(new Refused('too-big')); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ buf: Buffer.concat(chunks), type: String(res.headers['content-type'] || ''), url: u.href }));
      stream.on('error', () => reject(new Refused('unreachable')));
    });
    req.on('timeout', () => { req.destroy(); reject(new Refused('unreachable')); });
    req.on('error', (e) => reject(new Refused(e && e.code === 'EREFUSED_PRIVATE' ? 'refused' : 'unreachable')));
    req.end();
  });
}

// Fetch a page or an image. Resolves { buf, type, url } or rejects with a
// `why`: 'refused' | 'too-big' | 'unreachable' | 'wrong-type'.
//   kind     'html' (text/html or xhtml) or 'image' (image/*)
//   maxBytes the cap, enforced while streaming
//   allow    (ip) => bool — tests only; defaults to "not private"
async function fetchPage(raw, { kind = 'html', maxBytes = 3 * 1024 * 1024, allow } = {}) {
  const ok = allow || ((ip) => allowPrivateEnv() || !privateAddr(ip));
  const accept = kind === 'image' ? 'image/*' : 'text/html,application/xhtml+xml';
  let u = checkUrl(raw, ok);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const got = await once(u, { accept, maxBytes, allow: ok });
    if (got.redirect) {
      if (hop === MAX_HOPS) throw new Refused('unreachable');
      u = checkUrl(got.redirect, ok);       // every hop is checked again
      continue;
    }
    const t = got.type.toLowerCase();
    const right = kind === 'image' ? t.startsWith('image/') : /text\/html|application\/xhtml\+xml/.test(t);
    if (!right) throw new Refused('wrong-type');
    return got;
  }
  throw new Refused('unreachable');
}

module.exports = { fetchPage, privateAddr, guardedLookup, checkUrl, Refused, UA, MAX_HOPS };
