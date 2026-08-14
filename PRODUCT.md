# Product

## Register

product

## Users

People who are not developers, building their first real piece of software. They
have an idea, a computer, and a Claude subscription. They do not have a mental
model of terminals, package managers, git, or what a "session" is.

Their context when using Shipyard: at their own desk, unhurried but slightly
anxious. The dominant feeling is "I don't want to break something" closely
followed by "I don't know if this is working". They are not multitasking; they
are watching the screen, which means any unexplained pause reads as a fault.

The job to be done: describe the app they want, and end up with a real project on
disk that a capable AI is actively building, without ever having to understand
the machinery underneath.

## Product Purpose

Shipyard is a desktop app that drives the user's own Claude Code installation.

It finds or installs Claude Code, gets the user signed into their own Anthropic
account, asks seven plain-English questions about what they're building, turns
those answers into an architecture brief (`PROJECT.md`) that Claude reads before
writing any code, and then holds a live session against that project.

Shipyard never sees the user's data, never holds their credentials, and never
calls a model itself. It operates the CLI on the user's behalf, the way a person
would.

Success looks like: someone with no technical background completes setup and the
intake in under five minutes, sees a description of their app's architecture that
matches what they asked for, and watches Claude start building it, without once
being shown a terminal or asked to make a technical decision they can't evaluate.

## Brand Personality

Calm, patient, honest.

The voice is that of a competent person sitting beside you who is comfortable
saying "this takes about ten seconds" and equally comfortable saying "that
didn't work, here's what we'll try". It never performs enthusiasm, never
celebrates trivial progress, and never hides a problem to preserve the mood.

Emotional goal: **reassurance through legibility**. The user should always be
able to answer "what is happening right now?" and "what happens if I click
this?" without asking anyone. Confidence comes from the interface being
predictable, not from it being impressive.

## Anti-references

- **Not a developer tool.** No terminal-green aesthetics, no monospace as a
  default voice, no dense config panels, no jargon surfaced in the interface.
  Words like "PTY", "session state", "stdout", "repo", and "CLI" do not belong
  in anything the user reads by default. Raw output stays available behind an
  explicit "show details", never in the primary view.
- The interface should not require the user to already understand the thing it
  is doing for them. If a screen only makes sense to someone who has used a
  terminal, it has failed.

## Design Principles

1. **Waiting is not failing.** The model can think for ten seconds or more
   before producing a single character. That silence is the single most likely
   moment for a first-time user to conclude the app is broken. Every wait must
   name itself, and long waits must show that something is still happening.

2. **Never make them read a terminal.** The underlying CLI emits raw, pre-rendered
   terminal output. Shipyard's job is to translate machine state into plain
   language. Raw output is available on demand and never the default view.

3. **Consent stays explicit.** When Claude asks to change something, the user
   decides. The real choices are shown as the CLI offers them, in the user's
   words, never collapsed to a yes/no and never pre-answered on their behalf.
   This is the one place where friction is correct.

4. **Say what happened, not what ran.** Report outcomes in terms of the user's
   project ("created your sign-in page"), not in terms of the tools that
   produced them ("Write(src/auth/page.tsx)"). The tool name is detail, not
   headline.

5. **Nothing is a dead end.** Crashes, usage limits, missing installs, and
   failed sign-ins are all normal. Every failure state names what happened in
   plain language and offers the next action in the same view.

## Accessibility & Inclusion

Target WCAG 2.1 AA.

- Body text at or above 4.5:1 contrast; large text at or above 3:1. Muted text
  is for genuinely secondary content and still meets 4.5:1.
- Full keyboard operation, including the permission dialog, which must trap
  focus and be answerable without a mouse.
- Visible focus indicators everywhere. Never `outline: none` without a
  replacement.
- `prefers-reduced-motion: reduce` honored for every animation, including the
  thinking indicator and streaming cursor, both of which are continuous and
  therefore the most likely to cause discomfort.
- State is never communicated by color alone; every status carries text or shape
  as well.
