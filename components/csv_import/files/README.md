# Importing a spreadsheet

```ts
import { importCsv } from '@/components/csv_import/import';

const result = importCsv(await file.text(), FIELDS);
if (!result.ok) return Response.json({ problems: result.problems, summary: result.summary });
await saveAll(result.rows);
```

## The rule that makes it usable

**Never stop at the first bad row.** Rejecting a 900-row file because row 4 has
a malformed email, then rejecting it again at row 17, then at row 43, is the
experience that makes people give up and email you a spreadsheet instead.

Every row is checked, every problem comes back with the row number *as it
appears in their spreadsheet*, and the good rows are handed back separately —
importing 897 of 900 and listing the three that failed is almost always what
somebody wants.

## Their column names, not yours

Nobody's spreadsheet uses your field names. It says "E-mail Address", or "Client
Name", or "Tel". Making the founder rename their columns before uploading is
where most imports get abandoned, so this guesses — exact match, then declared
aliases, then containment — and shows the guess for them to correct.

The guess is always shown and always editable. Silently mapping "Name" to the
wrong field produces a database full of plausible nonsense, which is much worse
than failing.

## Things a real person's file does

A byte-order mark at the front. Semicolons instead of commas, because European
Excel exports those and does not mention it. Commas inside quoted company
names. Line breaks inside addresses. `£1,200` in a number column. All handled,
because all of them appear in the first file anybody uploads.

Values beginning with `=`, `+`, `-` or `@` are defused. Data imported from one
customer and exported to another is how a formula written by the first runs on
the second's machine.

## What it does not do

- CSV and tab-separated files. **Not `.xlsx`** — a spreadsheet has formulas,
  several sheets and merged cells, and reading one properly is a different job.
- It checks the shape of a value, not whether it is true. It cannot tell you
  the email address belongs to a real person.
- Everything is held in memory. Hundreds of thousands of rows need a different
  approach.
