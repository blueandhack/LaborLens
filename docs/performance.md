# Search performance

Search keeps literal, case-insensitive prefixes for employers, titles, locations and case numbers. Date filters use recorded calendar dates. Results are newest first, with a stable document-ID tie break so equal-date records do not jump between pages.

## Query and memory design

- Select and sort IDs from covering indexes before fetching the projected card fields. Full disclosure fields and alternate source records are loaded only on the details page.
- Evaluate combined filters against computed index metadata. This prevents MongoDB from fetching every matching disclosure to evaluate an OR expression.
- For common searches, try a bounded window of the recent-date index. A window that cannot fill the requested page falls back to the selective prefix index; it never truncates the result set. The trial has a 500 ms server limit and at most 20,000 index entries.
- Count city/state matches with inclusion/exclusion, so a record matching both appears once. Exact filtered totals have a bounded 128-entry, 30-second cache with concurrent request coalescing. Import/clear completion in the API invalidates it. Separate automatic imports become visible when this short cache expires; counts and pages are not a transactionally consistent snapshot during imports.
- Browser responses cache search results for 15 seconds, year options for five minutes and details for one minute. Hash-named static assets cache for a year; HTML must revalidate.
- Queries have server time limits, abandoned page selections are cancelled, page sizes are capped at 100, and connection pools are bounded. Deep or unusually broad requests can return HTTP 503 with a prompt to narrow the search.
- Production disables Mongoose automatic index creation. Only the indexes needed by the current search are declared. The unused text and older prefix/sort indexes can be removed after rollout. The unique case-number index is always preserved.
- MongoDB's WiredTiger cache budget is 384 MiB, down from 512 MiB. Its reservation is 640 MiB, while the existing 1536 MiB hard limit leaves room for server overhead and future index builds. The API and frontend also have explicit resource reservations/limits; the API retains heap headroom for streaming manual imports.

There are now eight indexes per case collection, including `_id` and the unique case number. Covering entries are wider than the former prefix-only entries: fewer indexes does not imply less total index storage. The tradeoff is additional disk space for greatly reduced document reads, with RAM controlled by the explicit cache budget.

The frontend uses native fetch and loads admin/detail code on demand, with a recoverable page-load error screen. Google Fonts starts loading from HTML instead of a serial CSS import. Nginx compresses assets and Traefik compresses API responses. A small SVG favicon replaces the large PNG on normal page loads; the PNG remains available for social previews.

## Measurements

Representative backend measurements against more than 4.2 million production cases, while historical imports were running:

| Search | Before | Optimized first count | Repeated within count-cache lifetime |
| --- | ---: | ---: | ---: |
| PWD employer `google` | 6.52 s | 0.22 s | 0.13 s |
| PERM employer `google` | 6.63 s | 0.18 s | 0.10 s |
| PWD job `software` | exceeded 25 s | 0.71 s | 0.02 s |
| PWD job `software`, location `ca` | exceeded the candidate's 10 s limit before covering refinements | 2.17 s | 0.02 s |

These are samples, not latency guarantees. Database cache warmth, background imports and exact-count work affect first requests; broad location counts can take several seconds. Browser/network latency is additional. Search correctness and zero-document index selection are verified separately with MongoDB integration tests and profiler assertions.

The initial JavaScript bundle fell from 323,255 bytes (103,640 bytes gzipped) to about 263 KB (83 KB gzipped). The admin and details bundles are downloaded separately when visited.

## Deployment and verification

Build the new indexes sequentially **before** switching search implementations. Run with a private `MONGO_URI` environment variable:

```sh
node scripts/search-indexes.js
node scripts/search-indexes.js --check
```

After all new backend replicas are ready with production automatic index creation disabled, remove only the known obsolete, non-unique indexes:

```sh
node scripts/search-indexes.js --check --prune-obsolete
```

The cleanup preserves unique, TTL, sparse, partial and hidden indexes, and unrelated indexes. Do not roll back to the old search image after pruning without rebuilding its former hinted indexes. Database documents are not modified by index migration.

Run the backend suite with `MONGO_TEST_URI` pointing to a test MongoDB 9 server. Each integration test creates and removes its own uniquely named database. Tests check filter semantics, case-insensitive identifier/state prefixes, overlapping location counts, page ordering, related PWD dates, cancellation and the older-record fallback. Profiler assertions verify that normal combined queries fetch only the displayed disclosure page.

References: [MongoDB prefix regex indexes](https://www.mongodb.com/docs/manual/reference/operator/query/regex/), [MongoDB index sorting](https://www.mongodb.com/docs/manual/tutorial/sort-results-with-indexes/), [driver cancellation](https://www.mongodb.com/docs/drivers/node/current/crud/query/cursor/), [Traefik compression](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/compress/).
