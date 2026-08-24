# /art/v1/ — the v3 art library (versioned, immutable)

Empty until P3. Everything here is served with `Cache-Control: immutable` (see `public/_headers`),
because `public/` filenames are not content-hashed by Vite.

**Therefore: never edit a file in place here.** To change art, bump to `/art/v2/` and update the
manifest. Editing in place pins the stale texture in every returning player's cache for a year.

Produced by `scripts/build-art.mjs` (P1-05): source → normalize → encode → manifest.
