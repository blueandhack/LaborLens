# LaborLens SEO audit and proposed targets

Research date: November 7, 2026. This is an audit and proposed roadmap, not a report of deployed SEO changes or achieved rankings.

## First release checkpoint

The user reported completing Search Console setup, and a Google verification TXT record was observed in public DNS. Search Console performance and indexing reports have not been accessed.

The first technical release implements build-time HTML rendering for `/`, `/h1b`, `/perm`, and `/data`; distinct initial and client-navigation metadata; a valid sitemap and origin robots file; noindex responses for filtered searches and administration; canonical/legacy redirects; and real HTTP 404 responses for unknown paths and malformed case URLs. Cloudflare's existing managed crawler policy is preserved. The public `/data` page explains sources, coverage limitations, wages, dates, and validation.

Case records still load through the existing client API. Valid case pages set their own metadata after loading; missing or failed records set noindex. A well-formed but nonexistent 24-character case ID still receives the client shell with HTTP 200 before its API result. Serving record-specific HTTP status and HTML for that case requires a future server-rendered case endpoint. Case URLs are not included in the initial sitemap.

The production container passed Nginx validation, HTTP metadata/indexing/redirect checks, JavaScript-disabled content checks, and responsive search checks at 17 widths from 320 to 3440 pixels. All 18 frontend unit tests and lint passed. Search Console sitemap submission, URL Inspection, performance baselining, employer profiles, and analytics-event verification remain separate next steps; this release makes no ranking claim.

## Objective and audience

Help people researching US employers and immigration-related wages find the relevant public filing and understand its source. Start with job seekers and people comparing employers; the same source transparency also serves researchers and immigration teams.

Primary product metric: organic-search visits that lead to a useful search or a case disclosure view. Track non-brand organic clicks and landing-page engagement alongside query visibility. Ranking for `H1B database` is a longer-term aspiration, not a guaranteed outcome or the only success metric.

Proposed positioning: **Free H-1B, PERM, and prevailing-wage research with traceable DOL sources and wages in their reported pay periods.**

## Keyword-to-page map

These priorities reflect relevance and sampled search results. No paid keyword-volume or difficulty data was available, and Search Console performance has not been accessed. They are not claims that a particular term is easy to rank for.

| Priority | Search intent / example queries | Intended page | Work needed |
|---|---|---|---|
| First | `H1B LCA search`, `H1B LCA lookup`, `H1B salary database` | `/h1b` | Route-specific HTML metadata, crawlable explanation, clear source and coverage information |
| First | `PERM database`, `PERM case search`, `PERM employer search` | `/perm` | Distinct metadata and explanation of historical disclosure search |
| First | `prevailing wage determination search`, `DOL PWD case search` | `/` (current PWD search) | Clarify the immigration-data context and give this page its own canonical identity |
| Next | `[employer] H1B salary [year]`, `[employer] H1B LCA history` | New employer profiles | Verified legal-entity handling, useful summaries, source periods, and links to matching cases |
| Next | `[employer] PERM filings`, `[employer] green card sponsorship history` | Employer profiles with distinct program sections | Separate PERM and H-1B counts and explain what a filing establishes |
| Next | `[occupation] H1B salary [city]` | Selected occupation/location pages | Worksite-aware data, sufficient samples, pay-period separation, and unique analysis |
| Longer term | `H1B database`, `H1B salary` | `/h1b` and its supporting browse hierarchy | Strong landing page, useful linked profiles, reliable coverage, and earned references |

Use natural H1B / H-1B wording on the same relevant page. Avoid separate near-duplicate pages for each spelling. Keep current search URLs stable during the first release.

Do not initially target live USCIS case tracking, visa approval predictions, current job vacancies, or live processing-time queries. Those intentions extend beyond the historical disclosure product. Broad `prevailing wage` searches also overlap with construction/government-contract wage determinations; qualify our content accordingly.

## Verified technical findings

The live public responses and repository source were inspected on the research date:

1. `/`, `/h1b`, and `/perm` return the same initial title: `LaborLens | PWD & PERM case research`.
2. All three declare `https://laborlens.fyi/` as their canonical URL. The H-1B and PERM pages should have their own canonical identities. Google treats canonical annotations as signals and may choose a different canonical; this audit does not establish what Google has selected.
3. The shared description and social metadata omit H-1B. React updates the document title after loading, but does not correct the description or canonical.
4. `/sitemap.xml` returns HTTP 200 with the application HTML, not a sitemap.
5. `/robots.txt` contains Cloudflare-managed directives followed by the application HTML. Search is allowed by the managed wildcard group. Serve a real origin robots file while preserving the operator's existing Cloudflare crawler policies.
6. The search pages' initial HTML body contains an empty React root. Google can render JavaScript; pre-rendering the public landing content would also make it immediately available to users and crawlers that do not execute JavaScript.
7. `/admin/data` inherits `index, follow`. Administrative and recovery utility pages need explicit indexing policies.
8. An unknown route and an invalid case URL both return the application shell with HTTP 200. Unknown pages need appropriate missing-page handling; nonexistent case handling also needs to avoid misleading indexable responses.
9. No employer or occupation browse hierarchy currently exists in the application. The current query-string search is useful to visitors, but it does not supply the dedicated, substantive entity pages proposed above.

Search research surfaced an older cached LaborLens homepage in a broad query, while a separate `site:laborlens.fyi` query returned no results in the research tool. These observations are not a Google index count, a ranking audit, or proof of deindexing. Use Search Console URL Inspection and indexing reports to establish the actual state.

## First implementation release

- Serve route-specific initial titles, descriptions, canonicals, and share metadata for the three program pages. Suggested H-1B title: **H1B Salary Database & LCA Search | LaborLens**.
- Provide useful public landing content in the initial HTML, consistent with the interactive page: what can be searched, where records originate, wage/date interpretation, and known coverage limitations. Use the same content for visitors and crawlers.
- Publish a valid XML sitemap and clean origin robots file. Include only canonical, indexable public pages that actually exist. Submitting a sitemap does not guarantee indexing.
- Handle administrative pages, unknown URLs, and missing records deliberately. Define a query-parameter crawl/index policy; do not consolidate every distinct page to the homepage.
- Preserve crawlable case links and plan discovery before exposing a very large case sitemap. Avoid adding millions of low-value URLs at once.
- Expose a public data/methodology and coverage page. Derive coverage from verified completed imports, distinguish annual/cumulative coverage from separately imported quarters, and show the latest source period. Do not advertise a complete historical range while backfill or validation is incomplete.
- Check Google Search Console property access and inspect the three program URLs. Establish a baseline for queries, clicks, impressions, CTR, indexing, Google-selected canonicals, and mobile performance.
- Verify analytics can measure search and case-view actions without sending raw search text or personal information as event parameters.

## Content and discovery release

Start with approximately 20 carefully selected employer profiles, expanding only where the data supports a useful page. Selection should combine actual dataset coverage, user demand, Search Console query evidence, and SERP review; famous employers can be competitive too.

Each profile should provide meaningful employer-specific content: legal names and verified aliases, separate program counts, verified source periods, role/worksite breakdowns, pay-period-specific wage summaries and sample sizes, and links to the underlying cases. Employer location and worksite are different fields; the current search filter uses the employer address.

Do not describe wages as actual payroll or total compensation. Do not silently annualize hourly wages or combine values with missing pay periods. Explain how records and duplicates are counted. The current H-1B timeline uses the last recorded action, which may be a later withdrawal; do not label that distribution as initial filing or certification volume.

Add a browsable employer directory and selected occupation/location pages after validating their unique value. Publish a small number of original, reproducible findings that reference these pages. Seek voluntary references from career resources, researchers, and relevant publications. Outreach requires a separate explicit instruction before sending messages.

Avoid purchased ranking links, keyword stuffing, or mass-produced pages that merely change a company/city name. The underlying DOL data is shared with competitors; useful interpretation, provenance, completeness, and usability must supply additional value.

## Proposed campaign milestones

These are working targets, not traffic or ranking forecasts. Reset them after obtaining a Search Console baseline.

| Period | Proposed success criterion |
|---|---|
| First 2 weeks | Resolve the verified crawl/metadata defects, verify Search Console access, record the baseline, and confirm analytics events |
| First 30 days | Have the three program landing pages eligible for indexing, submitted, and checked in URL Inspection; investigate any indexing or canonical discrepancies |
| Days 30–90 | Publish roughly 20 substantive employer profiles and supporting methodology/coverage content; measure non-brand impressions, clicks, and useful search/case actions |
| Months 3–6 | Aim for sustained first-page visibility for 5–10 specific, relevant long-tail queries, with growing qualified organic usage |
| Ongoing | Review `H1B database` and `H1B salary database` as competitive stretch terms and expand the content that demonstrably attracts relevant users |

Review US English search performance by page, query family, device, and country. Search Console average position is an aggregate metric, not a fixed universal rank. Do not set an absolute visitor target before observing the baseline.

## Research references

Sampled competitor pages illustrate current positioning and page structure, not independently verified traffic, ranking positions, or database completeness:

- [Levels.fyi H-1B salary database](https://www.levels.fyi/h1b/): company, role, and location salary search.
- [H1B Data Hub database page](https://h1bdatahub.com/h1b-database): dedicated database landing page, source coverage, and methodology explanation.
- [MyVisaJobs employer search](https://www.myvisajobs.com/employers/search.aspx): employer-centered discovery across filing programs.
- [Croma PERM database search](https://usecroma.com/en/us/tools/perm-labor-certification-search): explicit PERM database positioning and full-record search explanation.
- [PERM Timeline employer lookup](https://permtimeline.org/perm-employer-lookup/): employer-level aggregate pages and stated source period.

Primary technical guidance:

- [Google SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide): useful content, clear page identity, realistic expectations; meta keywords do not affect ranking.
- [Google JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics): rendering, unique metadata, canonical consistency, and pre-rendering.
- [Google canonical URL guidance](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls): canonical signals and consistency between initial and rendered HTML.
- [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap): canonical URL discovery and sitemap limitations.
- [Google faceted navigation guidance](https://developers.google.com/crawling/docs/faceted-navigation): managing large filtered URL spaces.
- [Google Search spam policies](https://developers.google.com/search/docs/essentials/spam-policies): doorway pages, scaled-content abuse, and link spam.
- [Search Console performance reporting](https://support.google.com/webmasters/answer/7576553): clicks, impressions, CTR, average position, and reporting dimensions.
