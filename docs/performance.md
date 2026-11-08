# Search performance

Search uses case-insensitive prefixes for employers, titles, locations and case numbers. Employer names tolerate punctuation and spacing differences. Date filters use recorded calendar dates. Results are newest first, with a stable document-ID tie break so equal-date records do not jump between pages.

## Results before totals

The search UI requests `count=deferred` on all three program endpoints. Case selection does not start or await an expensive total-count query. It reads at most one extra ID to establish `hasNextPage`, then fetches only the requested page of disclosure summaries. A cached total can be returned immediately. A complete first page with no extra ID establishes its own total, including zero, without another count request.

Deferred responses include `cases`, `currentPage`, `hasNextPage`, and nullable `totalCount` / `totalPages`. A missing total means unknown, never zero. The UI shows the displayed record range and “Counting total… You can browse now.” Next/Previous work while counting; the final page disables Next using the extra-ID result. Empty first pages and pages outside the available results have distinct recovery states.

After records arrive, the UI requests `/api/search/count`, `/api/search/perm/count`, or `/api/search/h1b/count` with the same filters. These return `{ totalCount }`. Filtered totals are exact for their database read, while unfiltered totals retain the existing fast `estimatedDocumentCount` behavior. Totals use the existing 30-second cache and are not a transactional snapshot with the records during imports. The API without `count=deferred` retains its original response and total-count behavior for existing clients.

The total request survives page, page-size, and layout changes for the same filters. Changing filters cancels the obsolete browser request and prevents its response from replacing the current total. A failed total displays an independent “Retry total” action and leaves case records and pagination available. At most two distinct total computations can run per backend process; identical filters coalesce, and excess requests fail promptly rather than queueing additional scans. Shared database counts may continue after a browser disconnects, within their database time limits, so another page can reuse them. Case selection remains cancellable.

Covered metadata queries avoid re-evaluating leading regex predicates after those predicates already ran on the index. This reduces repeated work for broad title/state filters without changing prefix or city/state overlap semantics. No new indexes or database migration are needed for this change.

## Query and memory design

- Select and sort IDs from covering indexes before fetching the projected card fields. Full disclosure fields and alternate source records are loaded only on the details page.
- Evaluate combined filters against computed index metadata. This prevents MongoDB from fetching every matching disclosure to evaluate an OR expression.
- For common searches, try a bounded window of the recent-date index. A window that cannot fill the requested page falls back to the selective prefix index; it never truncates the result set. The trial has a 500 ms server limit and at most 20,000 index entries.
- Count city/state matches with inclusion/exclusion, so a record matching both appears once. Exact filtered totals have a bounded 128-entry, 30-second cache with concurrent request coalescing. Import/clear completion in the API invalidates it. Separate automatic imports become visible when this short cache expires; counts and pages are not a transactionally consistent snapshot during imports.
- Browser responses cache search results for 15 seconds, year options for five minutes and details for one minute. Hash-named static assets cache for a year; HTML must revalidate.
- Queries have server time limits, abandoned page selections are cancelled, page sizes are capped at 100, and connection pools are bounded. Deep or unusually broad requests can return HTTP 503 with a prompt to narrow the search.
- Production disables Mongoose automatic index creation. Only the indexes needed by the current search are declared. The unused text and older prefix/sort indexes can be removed after rollout. The unique case-number index is always preserved.
- MongoDB's WiredTiger cache budget is 384 MiB, down from 512 MiB. Its reservation is 640 MiB, while the existing 1536 MiB hard limit leaves room for server overhead and future index builds. The API and frontend also have explicit resource reservations/limits; the API retains heap headroom for streaming manual imports.

The original search uses eight indexes per case collection, including `_id` and the unique case number. Employer/worksite discovery adds a normalization-progress index and three partial covering worksite indexes, for twelve after its migration. See [employer discovery](employers.md). Covering entries are wider than the former prefix-only entries: fewer indexes does not imply less total index storage. The tradeoff is additional disk space for greatly reduced document reads, with RAM controlled by the explicit cache budget.

The frontend uses native fetch and loads admin/detail code on demand, with a recoverable page-load error screen. Google Fonts starts loading from HTML instead of a serial CSS import. Nginx compresses assets and Traefik compresses API responses. A small SVG favicon replaces the large PNG on normal page loads; the PNG remains available for social previews.

[Search insights](search-insights.md) adds optional SVG charts for the current search or whole imported program. Status metadata extends five existing covering indexes; the final index count remains eight per collection. Charts load separately (about 3 KB JS and 1.3 KB CSS gzipped), use a short bounded cache and database time budget, and read a persisted summary for the whole dataset. They do not increase the MongoDB cache budget or load full disclosure documents on normal analytics paths.

## Measurements

Earlier backend measurements against more than 4.2 million production cases, while historical imports were running (before H-1B and deferred totals):

| Search | Before | Optimized first count | Repeated within count-cache lifetime |
| --- | ---: | ---: | ---: |
| PWD employer `google` | 6.52 s | 0.22 s | 0.13 s |
| PERM employer `google` | 6.63 s | 0.18 s | 0.10 s |
| PWD job `software` | exceeded 25 s | 0.71 s | 0.02 s |
| PWD job `software`, location `ca` | exceeded the candidate's 10 s limit before covering refinements | 2.17 s | 0.02 s |

These are samples, not latency guarantees. Database cache warmth, background imports and exact-count work affect first requests; broad location counts can take several seconds. Browser/network latency is additional. Search correctness and zero-document index selection are verified separately with MongoDB integration tests and profiler assertions.

After reducing the cache to 384 MiB, live HTTPS requests through the production ingress measured employer searches at 0.31–0.33 seconds initially and 0.13–0.16 seconds on repeat. Broad `software` searches took 0.88–0.99 seconds initially and 0.06–0.07 seconds on repeat. The PWD state-only `CA` count took 3.87 seconds initially and 0.08 seconds on repeat. These measurements included a running historical importer. Final interactive browser verification was unavailable because the browser automation host was offline; HTTP responses, production health, compression/cache headers, builds and integration tests were verified directly.

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

Deferred-total regression tests also verify that cases return while a count is blocked, only one extra ID is used for Next, final/empty/outside pages remain distinct, simultaneous count work is bounded and coalesced, and separate count endpoints preserve the existing filter semantics. Browser checks exercise delayed/failed totals, retry, stale responses, pagination during counting, and responsive states from 320 to 3440 pixels for PWD, PERM, and H-1B.

References: [MongoDB prefix regex indexes](https://www.mongodb.com/docs/manual/reference/operator/query/regex/), [MongoDB index sorting](https://www.mongodb.com/docs/manual/tutorial/sort-results-with-indexes/), [driver cancellation](https://www.mongodb.com/docs/drivers/node/current/crud/query/cursor/), [Traefik compression](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/compress/).
