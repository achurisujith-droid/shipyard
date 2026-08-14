/**
 * Regression tests for the menu parser, using screens captured from the real
 * CLI.
 *
 * The review step of Claude's question form is the important one: it has no
 * key-hint line, and requiring one made the parser return null at exactly the
 * step that unblocks the session. The CLI then waited forever and the app
 * looked dead. That bug shipped once; these fixtures stop it shipping twice.
 *
 *   npx tsx harness/test-menu.ts
 */
import { classifyMenu, parseMenu } from '../src/parse/menu';

interface Case {
  name: string;
  screen: string;
  expect: (menu: ReturnType<typeof parseMenu>) => string | null;
}

const TRUST = `
────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 C:\\projects\\demo

 Quick safety check: Is this a project you created or one you trust?

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

const PERMISSION = `
────────────────────────────────────────────────────────────────────────
 Create file
 app.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 ok
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create app.txt?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No

 Esc to cancel · Tab to amend
`;

const QUESTION = `
────────────────────────────────────────────────────────────────────────
←  ☐ Site type  ☐ Tech stack  ✔ Submit  →

What kind of site do you want to build?

❯ 1. Personal portfolio
     A one-page site about you: bio, projects, links, contact.
  2. Product / landing page
     A marketing page for an app, tool, or service.
  3. Blog
     A site with an index of posts and individual post pages.
  5. Type something.
────────────────────────────────────────────────────────────────────────
  6. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

/** The step that used to return null. No hint line anywhere. */
const REVIEW = `
────────────────────────────────────────────────────────────────────────
←  ☒ Site type  ☒ Tech stack  ✔ Submit  →

Review your answers

 ● What kind of site do you want to build?
   → Personal portfolio
 ● How should it be built?
   → Plain HTML/CSS/JS (Recommended)

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`;

/** Assistant prose containing a numbered list must NOT look like a menu. */
const PROSE = `
● Here are the steps I'll take:

  1. Create the project folder
  2. Add an index.html
  3. Wire up the stylesheet

✻ Crunched for 3s
`;

const cases: Case[] = [
  {
    name: 'workspace trust dialog',
    screen: TRUST,
    expect: (m) => {
      if (!m) return 'expected a menu';
      if (m.options.length !== 2) return `expected 2 options, got ${m.options.length}`;
      if (classifyMenu(m) !== 'permission') return `expected permission, got ${classifyMenu(m)}`;
      return null;
    },
  },
  {
    name: 'tool permission prompt',
    screen: PERMISSION,
    expect: (m) => {
      if (!m) return 'expected a menu';
      if (m.options.length !== 3) return `expected 3 options, got ${m.options.length}`;
      if (classifyMenu(m) !== 'permission') return `expected permission, got ${classifyMenu(m)}`;
      return null;
    },
  },
  {
    name: 'question step, with descriptions and tabs',
    screen: QUESTION,
    expect: (m) => {
      if (!m) return 'expected a menu';
      if (classifyMenu(m) !== 'question') return `expected question, got ${classifyMenu(m)}`;
      if (!m.tabs || m.tabs.length !== 3) return `expected 3 tabs, got ${m.tabs?.length ?? 0}`;
      if (m.tabs.some((t) => t.done)) return 'no tab should be done yet';
      if (!m.options[0]?.description?.includes('bio, projects')) {
        return 'first option lost its description';
      }
      if (!/what kind of site/i.test(m.header)) return `header wrong: ${m.header}`;
      return null;
    },
  },
  {
    name: 'REVIEW STEP (no hint line) - the hang',
    screen: REVIEW,
    expect: (m) => {
      if (!m) return 'returned null - the session would hang here';
      if (m.options.length !== 2) return `expected 2 options, got ${m.options.length}`;
      if (m.options[0]?.label !== 'Submit answers') return `expected Submit first`;
      if (classifyMenu(m) !== 'review') return `expected review, got ${classifyMenu(m)}`;
      if (!m.tabs?.every((t) => t.isSubmit || t.done)) return 'tabs should read as answered';
      return null;
    },
  },
  {
    name: 'assistant prose with a numbered list is not a menu',
    screen: PROSE,
    expect: (m) => (m === null ? null : `false positive: parsed ${m.options.length} options`),
  },
];

let failed = 0;
for (const testCase of cases) {
  const menu = parseMenu(testCase.screen.split('\n'));
  const problem = testCase.expect(menu);
  if (problem) {
    failed += 1;
    console.log(`FAIL  ${testCase.name}\n        ${problem}`);
  } else {
    console.log(`PASS  ${testCase.name}`);
  }
}

console.log(`\n${failed === 0 ? 'All menu cases pass.' : `${failed} case(s) failed.`}`);
process.exitCode = failed > 0 ? 1 : 0;
