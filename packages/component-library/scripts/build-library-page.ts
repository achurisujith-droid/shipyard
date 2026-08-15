/**
 * Build the public library page.
 *
 * Generated from the manifests themselves rather than written by hand, so the
 * page cannot describe a component that does not exist or claim a trust level
 * the manifest does not carry. A hand-written catalogue drifts from the code
 * within a fortnight and there is no way to notice.
 *
 * Worth being clear about what this page is and is not. It is somewhere to
 * **look** — to link to, to send to somebody, to search before starting. It is
 * not where the app gets components from: the desktop app installs from the
 * copy inside the installer, offline, with no network call. Fetching code over
 * the internet and writing it into somebody's project is a supply-chain surface
 * that needs signing and integrity checks, and none of that is built.
 *
 *   npx tsx packages/component-library/scripts/build-library-page.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary } from '../src/index';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TRUST_NOTE: Record<string, string> = {
  verified: 'Its own tests were run against a real install and passed.',
  provisional: 'Installs and its logic is tested, but part of it needs a real account to prove.',
  experimental: 'Here to be looked at. Not relied on.',
};

async function main(): Promise<void> {
  const components = await loadLibrary(path.join(repoRoot, 'components'));
  const roadmap = await readFile(path.join(repoRoot, 'components', 'ROADMAP.md'), 'utf8').catch(() => '');
  const planned = (roadmap.match(/^\| `[a-z_]+` \|/gm) ?? []).length;

  const byTier = {
    capability: components.filter((entry) => (entry.manifest.tier ?? 'capability') === 'capability'),
    utility: components.filter((entry) => entry.manifest.tier === 'utility'),
  };

  const card = (manifest: (typeof components)[number]['manifest']): string => `
      <article class="card" id="${escape(manifest.id)}">
        <header>
          <h3>${escape(manifest.name)}</h3>
          <span class="trust trust-${escape(manifest.trust)}" title="${escape(TRUST_NOTE[manifest.trust] ?? '')}">${escape(manifest.trust)}</span>
        </header>
        <p class="summary">${escape(manifest.summary)}</p>
        ${
          manifest.solves?.length
            ? `<p class="solves"><span>Use it when you need to</span> ${manifest.solves
                .slice(0, 3)
                .map((phrase) => `<em>${escape(phrase)}</em>`)
                .join(', ')}.</p>`
            : ''
        }
        ${
          manifest.limitations?.length
            ? `<details><summary>What it does not do</summary><ul>${manifest.limitations
                .map((limitation) => `<li>${escape(limitation)}</li>`)
                .join('')}</ul></details>`
            : ''
        }
        <footer>
          <code>${escape(manifest.id)}</code>
          <span>v${escape(manifest.version)}</span>
          <span>${escape(manifest.provenance.license)}</span>
        </footer>
      </article>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shipyard component library</title>
<meta name="description" content="${components.length} tested components a Shipyard project can install instead of generating.">
<style>
  :root { --bg:#fff; --fg:#14181f; --muted:#5b6472; --line:#e3e7ec; --accent:#1f6f43; --warn:#8a5a00; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#101318; --fg:#e9edf3; --muted:#99a3b1; --line:#262c35; --accent:#6dd39b; --warn:#e0b25e; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:3rem 1.5rem; background:var(--bg); color:var(--fg);
         font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size:2rem; letter-spacing:-0.02em; margin:0 0 .5rem; }
  h2 { font-size:1.25rem; margin:3rem 0 .25rem; }
  p.lede, p.tier-note { color:var(--muted); max-width:44rem; }
  .grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fill,minmax(19rem,1fr)); margin-top:1.5rem; }
  .card { border:1px solid var(--line); border-radius:.75rem; padding:1.25rem; display:flex; flex-direction:column; gap:.5rem; }
  .card header { display:flex; align-items:baseline; justify-content:space-between; gap:.5rem; }
  .card h3 { font-size:1rem; margin:0; }
  .summary { margin:0; color:var(--muted); font-size:.925rem; }
  .solves { margin:0; font-size:.85rem; color:var(--muted); }
  .solves span { text-transform:uppercase; letter-spacing:.06em; font-size:.7rem; display:block; }
  .solves em { font-style:normal; color:var(--fg); }
  .trust { font-size:.7rem; text-transform:uppercase; letter-spacing:.06em; padding:.1rem .5rem; border-radius:999px; white-space:nowrap; }
  .trust-verified { background:color-mix(in oklab, var(--accent) 18%, transparent); color:var(--accent); }
  .trust-provisional { background:color-mix(in oklab, var(--warn) 18%, transparent); color:var(--warn); }
  .trust-experimental { background:var(--line); color:var(--muted); }
  details { font-size:.85rem; color:var(--muted); }
  details ul { margin:.5rem 0 0; padding-left:1.1rem; }
  .card footer { margin-top:auto; padding-top:.75rem; border-top:1px solid var(--line);
                 display:flex; gap:.75rem; font-size:.75rem; color:var(--muted); }
  code { font-family:ui-monospace,"Cascadia Mono",Menlo,monospace; }
  .note { border-left:3px solid var(--line); padding-left:1rem; color:var(--muted); font-size:.925rem; max-width:44rem; }
  a { color:var(--accent); }
  table { border-collapse:collapse; width:100%; font-size:.9rem; margin-top:1rem; }
  th,td { text-align:left; padding:.4rem .6rem; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; }
</style>
</head>
<body>
<main>
  <h1>Component library</h1>
  <p class="lede">
    ${components.length} tested pieces a Shipyard project can install instead of
    asking an agent to invent them. Each one ships with its own tests, and those
    tests run inside the project it was installed into.
  </p>

  <p class="note">
    This page is somewhere to look. The app installs from the copy inside the
    installer, offline — nothing is fetched over the network and written into
    your project.
  </p>

  <h2>Capabilities</h2>
  <p class="tier-note">Things a product owes its users. A missing one can block a launch.</p>
  <div class="grid">${byTier.capability.map((entry) => card(entry.manifest)).join('')}
  </div>

  <h2>Utilities</h2>
  <p class="tier-note">Jobs of work. A missing one just means somebody writes it by hand.</p>
  <div class="grid">${byTier.utility.map((entry) => card(entry.manifest)).join('')}
  </div>

  <h2>What the labels mean</h2>
  <table>
    <tr><th>Label</th><th>What it means</th></tr>
    ${Object.entries(TRUST_NOTE)
      .map(([level, note]) => `<tr><td><span class="trust trust-${level}">${level}</span></td><td>${escape(note)}</td></tr>`)
      .join('')}
  </table>
  <p class="tier-note">
    <strong>verified</strong> means something ran. It is not a judgement about how
    good the code looks — the contract tests were executed against a real install
    of the starter template and passed, and nothing else earns it.
  </p>

  <h2>Not built yet</h2>
  <p class="tier-note">
    ${planned} more are written down as intentions in
    <a href="https://github.com/achurisujith-droid/shipyard/blob/main/components/ROADMAP.md">the roadmap</a>.
    None of them exist, and none are listed above — a catalogue that shows things
    you cannot install is a catalogue nobody trusts twice.
  </p>

  <p class="tier-note" style="margin-top:3rem">
    <a href="https://github.com/achurisujith-droid/shipyard/blob/main/docs/COMPONENT-LIBRARY.md">How the library works</a> ·
    <a href="../">Shipyard</a>
  </p>
</main>
</body>
</html>
`;

  const out = path.join(repoRoot, 'site', 'library');
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'index.html'), html, 'utf8');

  console.log(`Wrote site/library/index.html`);
  console.log(`  ${byTier.capability.length} capabilities, ${byTier.utility.length} utilities`);
  console.log(`  ${components.filter((entry) => entry.manifest.trust === 'verified').length} verified, ${planned} planned`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
