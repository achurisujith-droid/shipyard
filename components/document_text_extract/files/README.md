# Reading uploaded documents

```ts
import { extractText } from '@/components/document_text_extract/extract';

const result = await extractText(new Uint8Array(await file.arrayBuffer()));
if (!result.ok) return Response.json({ error: result.message }, { status: 400 });
// result.text is the words, result.words is how many
```

Works out what the file is from its bytes, not its name. `cv.pdf` containing a
Word document is a thing that happens, and handing it to a PDF parser produces a
confusing error instead of a useful one.

## The case this exists for

**A scanned PDF does not fail — it succeeds at extracting nothing.** Somebody
photographs a contract, the library returns an empty string without erroring,
and your app saves a record with no content in it. Nobody finds out until a
person looks.

So `ok` has to be checked, and when it is false there is a sentence you can show
the person who uploaded the file: *"That PDF has no text in it — it is most
likely a scan, which is a picture of the words rather than the words
themselves."*

That is also why this never returns a bare string. A function returning `""`
makes it far too easy to store nothing and believe you stored something.

## What it does not do

- **No OCR.** Reading scans is a paid service and a separate decision.
- It gives you the words, not the meaning. Working out which bit is a phone
  number is your job.
- Old `.doc` files (Word 97) are not supported — it detects them and tells the
  user to save as `.docx`.
