/**
 * Does every text pairing in the UI meet WCAG AA?
 *
 * PRODUCT.md commits to WCAG 2.1 AA, and the failure mode is specific: light
 * grey text on a tinted near-white looks tasteful in a screenshot and is hard
 * to read at a kitchen table in daylight, which is where this app is used.
 *
 * Colours are declared in OKLCH, which no contrast tool reads directly, so this
 * converts to sRGB and applies the WCAG relative-luminance formula. It parses
 * the real stylesheet, so a token edit cannot drift away from these results.
 *
 *   node scripts/check-contrast.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STYLES = path.join(HERE, '..', 'renderer', 'styles.css');

/**
 * Pairings that actually appear in the interface.
 *
 * `size` is what the smallest instance renders at: AA wants 4.5:1 for body
 * text and allows 3:1 only at 18.66px+, or 14px+ when bold.
 */
const PAIRINGS = [
  ['--ink', '--bg', 'body text', 'normal'],
  ['--ink', '--surface', 'body text on a panel', 'normal'],
  ['--ink', '--surface-2', 'body text on a raised panel', 'normal'],
  ['--muted', '--bg', 'secondary text', 'normal'],
  ['--muted', '--surface', 'secondary text on a panel', 'normal'],
  ['--muted', '--surface-2', 'secondary text on a raised panel', 'normal'],
  ['--primary', '--bg', 'links and quiet buttons', 'normal'],
  ['--primary', '--surface', 'links on a panel', 'normal'],
  ['--primary', '--primary-soft', 'primary text on its own tint', 'normal'],
  ['--success', '--success-soft', 'success text on its tint', 'normal'],
  ['--warn', '--warn-soft', 'warning text on its tint', 'normal'],
  ['--danger', '--danger-soft', 'danger text on its tint', 'normal'],
  ['--danger', '--bg', 'error text', 'normal'],
  // Not text, but the boundary a user relies on to see that a control is a
  // control. SC 1.4.11 applies to these and not to decorative dividers, which
  // is why --border and --border-strong are absent from this list.
  ['--border-interactive', '--bg', 'button, input and composer borders', 'ui'],
  ['--border-interactive', '--surface', 'the same on a panel', 'ui'],
];

/** White on filled buttons: the label has to survive the fill. */
const ON_FILL = [
  ['--primary', 'the primary button'],
  ['--danger', 'a destructive button'],
];

async function main() {
  const css = await readFile(STYLES, 'utf8');
  const tokens = parseTokens(css);

  let failures = 0;
  const report = (label, ratio, required) => {
    const ok = ratio >= required;
    if (!ok) failures += 1;
    const mark = ok ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${ratio.toFixed(2).padStart(5)}:1  (needs ${required})  ${label}`);
  };

  console.log('Text pairings\n');
  for (const [fg, bg, label, kind] of PAIRINGS) {
    const foreground = tokens[fg];
    const background = tokens[bg];
    if (!foreground || !background) {
      console.log(`SKIP           ${label} — ${!foreground ? fg : bg} not found`);
      continue;
    }
    // 3:1 is the bar for interface boundaries; text needs 4.5:1.
    report(`${label}  (${fg} on ${bg})`, contrast(foreground, background), kind === 'ui' ? 3 : 4.5);
  }

  console.log('\nWhite labels on filled buttons\n');
  const white = { r: 1, g: 1, b: 1 };
  for (const [fill, label] of ON_FILL) {
    const background = tokens[fill];
    if (!background) continue;
    report(`${label}  (white on ${fill})`, contrast(white, background), 4.5);
  }

  console.log(
    failures === 0
      ? '\nEvery pairing meets WCAG AA.'
      : `\n${failures} pairing(s) below AA. Darken the foreground token until it passes.`,
  );
  process.exitCode = failures > 0 ? 1 : 0;
}

/** `--name: oklch(L C H[ / A]);` from the :root block. */
function parseTokens(css) {
  const tokens = {};
  const re = /(--[\w-]+)\s*:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/[^)]*)?\)/g;
  let match;
  while ((match = re.exec(css)) !== null) {
    const [, name, l, c, h] = match;
    // First declaration wins: :root comes before any later override.
    if (!(name in tokens)) tokens[name] = oklchToRgb(+l, +c, +h);
  }
  return tokens;
}

/** OKLCH -> OKLab -> linear sRGB -> gamma-encoded sRGB, clamped. */
function oklchToRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const encode = (v) => {
    const clamped = Math.min(1, Math.max(0, v));
    return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };

  return { r: encode(lr), g: encode(lg), b: encode(lb) };
}

/** WCAG 2.1 relative luminance and contrast ratio. */
function luminance({ r, g, b }) {
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
