# Making PDFs

```ts
import { renderInvoice } from '@/components/pdf_generate/invoice';
import { downloadHeaders } from '@/components/pdf_generate/document';

const bytes = await renderInvoice(invoice);
return new Response(bytes, { headers: downloadHeaders(`invoice-${invoice.number}.pdf`) });
```

`invoice.ts` is an example and is yours to change. The drawing and the
arithmetic it calls are not.

## Two things a PDF will not tell you

**It has no reflow.** Text that does not fit runs off the right edge and out of
the document, and nothing errors. A long product description silently produces
an invoice with half a line on it. So the wrapping and the page breaks are
computed as arithmetic — which means they can be tested, and checking a PDF by
opening it is not a test.

**Money has to be integers.** Amounts are whole pence throughout. `0.1 + 0.2` is
not `0.3`, and an invoice that is a penny out is a conversation with a customer
that costs more than the penny. Tax is worked out per rate band and rounded
once; rounding every line and summing drifts by a penny or two on a long
invoice, and nobody can explain the difference later.

Rounding is half away from zero, the way an accountant expects — not
`Math.round`, which turns -0.5 into -0 and surprises people on credit notes.

## What it does not do

- Text and tables. No images, no charts, no custom fonts — the built-in fonts
  are Latin only, so **this cannot set Greek, Cyrillic, Arabic or CJK text**.
- It totals the lines you give it. What tax applies is your decision and your
  accountant's.
- An invoice produced here is not automatically a legal invoice. What has to
  appear on one differs by country.
