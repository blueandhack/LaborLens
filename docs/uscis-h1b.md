# USCIS H-1B petition decisions

`/h1b-approvals` and the "H-1B petition decisions" section of employer profiles use the
[USCIS H-1B Employer Data Hub](https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub).
It counts workers on H-1B petitions at USCIS's first decision. Each row is one fiscal year ×
petitioner (name, last four digits of its tax ID, mailing address) × two-digit NAICS code.

## Sources

| Fiscal years | Where | Format |
|---|---|---|
| FY2009–FY2023 | Archived CSV files on uscis.gov (`h1b_datahubexport-YYYY.csv`) | Initial/continuing approvals and denials |
| FY2024 onward | Only the hub's interactive view (Crosstab View → Download → CSV) | Six petition types |

The archived FY2023 file covers only part of the year (about a quarter of FY2022's initial
approvals). It is marked `partial` and left out of all-years totals.

Newer exports report six petition types. They are combined the way USCIS combines them:
initial = new employment + new concurrent + change of employer, and continuing = continuation +
change with the same employer + amended. The detailed counts are kept in `categories`.

## Importing

```bash
node scripts/import-uscis-h1b.js --official            # download and import FY2009–2023
node scripts/import-uscis-h1b.js export.csv [...]       # hub exports (CSV, or the UTF-16 tab-separated crosstab)
node scripts/import-uscis-h1b.js --relink              # re-link petitioner names to employers only
```

Administrators can also upload a hub export under **Administration → Site data → USCIS H-1B
decisions**. Each fiscal year in a file replaces that year. A file with fewer than half the
rows already imported for a year is refused, because that is usually a filtered export
(`--allow-smaller` overrides this).

## Collections

- `uscis_h1b`: the source rows, plus `nameKey`, `groupKey` and `industry`.
- `uscis_h1b_employers`: one document per `groupKey`, rebuilt with `$out` after each import.
  It holds yearly totals, the latest name and location, and `link` (the matched `employers._id`).
- `discovery_state` `uscis_h1b`: per-year row counts, sources, partial flags, the import job
  status and `revision` (which invalidates the API cache).

Both collections are zstd-compressed.

## Names

- **Grouping.** `groupKey` is the employer name key (`nameKey`) with common abbreviations
  expanded (SVCS → services, SOLNS → solutions, and so on).
- **Cut-off names.** Older files cut names at about 34 characters. A cut-off key of 30 or more
  characters joins the longer key that starts with it, when that is the only such key or
  holds at least 80% of their decisions.
- **Profile links.** A group links to a LaborLens employer whose `nameKey` equals one of its
  spellings, then its expanded key. Otherwise, for a cut-off name, it links when every employer
  name starting with that name belongs to one identity.
- **Refresh.** Links are refreshed nightly after the employer identities step, because new DOL
  filing names can add links.

A link is a name match, not a verified corporate relationship. In production, about 91% of
approvals had a matching employer name before prefix matching.
