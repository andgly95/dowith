// Turns the canvas's .dc.html artboards into plain, static HTML files you can open
// in a browser. Generated output lives in ../screens/; edit the .dc.html here and
// re-render rather than patching a screen by hand.
//
//   npm i --no-save linkedom
//   node design/recipes/mockup-src/render.mjs
//
// Each screen renders in its starting state. The interactive bits (servings, ticking
// ingredients, timers, the Mine / Linnea's switch) only work on the canvas.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'screens');

class DCLogic {
  constructor() { this.props = {}; this.state = {}; }
  setState(u) { Object.assign(this.state, u); }
}

function lookup(expr, scope) {
  expr = expr.trim();
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  return expr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
}
const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
const fill = (str, scope) => str.replace(HOLE, (_, e) => { const v = lookup(e, scope); return v == null ? '' : String(v); });

function processNode(node, scope) {
  if (node.nodeType === 3) {
    HOLE.lastIndex = 0;
    if (HOLE.test(node.textContent)) { HOLE.lastIndex = 0; node.textContent = fill(node.textContent, scope); }
    HOLE.lastIndex = 0;
    return [node];
  }
  if (node.nodeType !== 1) return [node];
  const tag = node.tagName.toLowerCase();
  if (tag === 'sc-for') {
    const list = lookup(node.getAttribute('list').replace(/^\{\{|\}\}$/g, ''), scope) || [];
    const as = node.getAttribute('as');
    const out = [];
    list.forEach((item, i) => {
      for (const child of [...node.childNodes]) out.push(...processNode(child.cloneNode(true), { ...scope, [as]: item, $index: i }));
    });
    return out;
  }
  if (tag === 'sc-if') {
    if (!lookup(node.getAttribute('value').replace(/^\{\{|\}\}$/g, ''), scope)) return [];
    const out = [];
    for (const child of [...node.childNodes]) out.push(...processNode(child, scope));
    return out;
  }
  for (const attr of [...node.attributes]) {
    const n = attr.name.toLowerCase();
    if (n.startsWith('on') || n.startsWith('hint-') || n === 'ref') { node.removeAttribute(attr.name); continue; }
    if (attr.value.includes('{{')) node.setAttribute(attr.name, fill(attr.value, scope));
  }
  for (const child of [...node.childNodes]) {
    const repl = processNode(child, scope);
    if (repl.length === 1 && repl[0] === child) continue;
    for (const r of repl) node.insertBefore(r, child);
    node.removeChild(child);
  }
  return [node];
}

function render(file, theme, title, extra = {}) {
  const src = fs.readFileSync(file, 'utf8');
  const helmet = (src.match(/<helmet>([\s\S]*?)<\/helmet>/) || [, ''])[1];
  const markup = src.split('</helmet>')[1].split('</x-dc>')[0];
  const js = src.split('data-dc-script')[1].split('>').slice(1).join('>').split('</script>')[0];
  const Component = new Function('DCLogic', js + '; return Component;')(DCLogic);
  const c = new Component();
  c.props = { theme, ...extra };
  const vals = c.renderVals();
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${markup}</body></html>`);
  const body = document.body;
  for (const child of [...body.childNodes]) {
    const repl = processNode(child, vals);
    if (repl.length === 1 && repl[0] === child) continue;
    for (const r of repl) body.insertBefore(r, child);
    body.removeChild(child);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<!-- Static render of the Do With recipes mockup. Generated, not hand-written:
     edit ../mockup-src/ and re-render rather than patching this file. -->
${helmet.trim()}
<style>html,body{margin:0;background:${vals.t.bg}}body{display:flex;justify-content:center}</style>
</head>
<body>
${body.innerHTML.trim()}
</body>
</html>
`;
}

export const SCREENS = [
  ['Recipes', '01-recipes', 'Recipes'],
  ['ImportRecipe', '02-reading-a-link', 'Reading a linked recipe'],
  ['ImportRecipe', '03-link-without-a-recipe', 'A link without a recipe', { result: 'none' }],
  ['Recipe', '04-recipe', 'A recipe, opened'],
  ['Cook', '05-cooking', 'Cooking, one step at a time'],
  ['CookDone', '06-made-it', 'Made it'],
  ['Pantry', '07-kitchen', 'Kitchen'],
];

fs.mkdirSync(path.join(OUT, 'forest'), { recursive: true });
for (const [src, out, title, extra] of SCREENS) {
  const file = path.join(HERE, src + '.dc.html');
  fs.writeFileSync(path.join(OUT, out + '.html'), render(file, 'dusk', `${title} (Dusk)`, extra));
  fs.writeFileSync(path.join(OUT, 'forest', out + '.html'), render(file, 'forest', `${title} (Forest)`, extra));
}
console.log('rendered', SCREENS.length, 'screens × 2 themes');
// Cook mode schedules a one-second tick while a timer runs; nothing here needs it.
process.exit(0);
