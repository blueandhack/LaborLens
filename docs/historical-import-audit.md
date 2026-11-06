# Historical DOL import audit

All 40 currently published PWD and PERM case-disclosure workbooks were downloaded, fingerprinted with SHA-256, and scanned in full on 2026-11-06. This is a source-file validation result; server import progress is reported separately under Admin → Import.

- Rows scanned: **4,530,352**.
- Duplicate rows: **8,080**.
- Rows rejected for missing case identifiers: **0**.
- Optional source-value issues: **871** (excel_error: 803, invalid_number: 7, invalid_date: 61).
- PERM coverage: FY2008–FY2026. PWD coverage: FY2010–FY2026; no PWD FY2008–FY2009 files are linked by DOL.

All files passed the case-identity/layout preflight after normalization. This does **not** mean DOL source values are error-free. Invalid optional values and Excel errors are represented as unavailable, flagged, and retained in original-value metadata. Missing fields are never inferred. The audit counts unique cases within each file; overlaps between fiscal-year releases mean their sum is not the final database case count.

The largest workbook was also fully audited and streamed through the production Node 18 import path in a container capped at 1 GB, using approximately 375 MB RSS.

## Compatibility rules

- Normalize spaces, case, and punctuation in headers; preserve duplicate header columns under distinct names.
- Map CASE_NO, legacy employer/title/wage/date fields, PWD FY2012's EMPLYER typo, and FY2013's PW_DETERM_DATE.
- PERM FY2013 uses ADD_THESE_PW_JOB_TITLE_9089 for the job title; the other title column repeats the SOC title. Both original fields remain available.
- Preserve missing received dates and the absent PERM FY2013 offered-wage period. Never substitute a prevailing-wage period for an offered-wage period.
- Read Excel's 1900/1904 date systems, preserve explicit postal-code zero padding and Unicode, and validate numeric/date values before MongoDB writes.
- Collapse identical duplicate rows; select the latest event for differing records and retain other versions/worksites in case details. Same-event ties use explicit review dates, then first source order.
- Preserve tracked newer records. For records lacking provenance, supplement missing canonical fields without replacing existing nonempty values.

## Per-year inventory

| Fiscal year | PERM files / rows | PWD files / rows |
|---|---:|---:|
| 2008 | 1 / 61,997 | Not published |
| 2009 | 1 / 38,247 | Not published |
| 2010 | 1 / 81,412 | 1 / 70,115 |
| 2011 | 1 / 73,207 | 1 / 103,390 |
| 2012 | 1 / 66,488 | 1 / 145,866 |
| 2013 | 1 / 44,152 | 1 / 124,883 |
| 2014 | 1 / 70,998 | 1 / 131,999 |
| 2015 | 1 / 89,299 | 1 / 139,120 |
| 2016 | 1 / 126,143 | 1 / 140,940 |
| 2017 | 1 / 97,603 | 1 / 182,725 |
| 2018 | 1 / 119,776 | 1 / 149,409 |
| 2019 | 1 / 102,655 | 1 / 169,781 |
| 2020 | 1 / 94,019 | 1 / 166,525 |
| 2021 | 1 / 108,264 | 2 / 160,062 |
| 2022 | 1 / 104,600 | 2 / 186,903 |
| 2023 | 1 / 116,427 | 2 / 254,466 |
| 2024 | 2 / 114,550 | 1 / 237,926 |
| 2025 | 1 / 147,056 | 1 / 249,555 |
| 2026 | 1 / 112,550 | 1 / 147,244 |

The [JSON audit](historical-import-audit.json) contains source URLs, hashes, byte sizes, original headers, mappings, missing-value counts, duplicate counts, and bounded examples of source issues for every file. Future changed files receive the same full-row validation before import.
