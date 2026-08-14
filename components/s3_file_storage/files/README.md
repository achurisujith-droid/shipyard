# Letting people upload files

Uploads go straight from the browser to your storage provider using a
short-lived signed link, rather than through your app.

That is not an optimisation. Routing a 25 MB upload through a Next.js route
means holding it in memory on a server sized for rendering pages, and a handful
of concurrent uploads is enough to take a small deployment down.

## How it works

1. The browser asks `POST /api/files/upload-url` with the name, type and size.
2. The route checks all three, records the file, and returns a link valid for
   five minutes.
3. The browser `PUT`s the file to that link.

Every check happens in step 2, because once the link exists the storage provider
will accept whatever is sent within the terms that were signed — including the
length, which is why it is signed too.

## The two things that go wrong with filenames

**A filename can be a path.** `../../../etc/passwd` is a valid thing to type
into a file picker. The stored key is generated, never derived from what the
user sent; the original name is kept separately, for display only.

**A predictable key is a guessable key.** Keys are random and prefixed with the
organisation id, so knowing one customer's file tells you nothing about
another's.

## What it does not do

- **Not run against a live bucket here.** The key handling and the limits are
  tested; the round trip is not. Upload one file and download it before relying
  on this.
- No virus scanning. If strangers can upload, you need that as well.
- No image resizing or thumbnails.
