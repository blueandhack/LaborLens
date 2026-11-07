# MongoDB 9 upgrade

MongoDB is pinned to `mongo:9.0.4`; the backend and its integration tests use Node 24, Mongoose 9.12, and the MongoDB Node driver 7.8. MongoDB's installed Node driver requires Node 20.19 or later. CI runs the real import integration suite against MongoDB 9.0.4.

## Migration and recovery

The former floating `mongo:8` image ran MongoDB 8.2.5 with FCV 8.2. That release reached end of life on July 31, 2026. MongoDB 9.0's published end-of-life date is October 31, 2031.

The migration uses a frozen, consistent application database backup, followed by the supported binary sequence `8.2.5 -> 8.3.13 -> 9.0.4`, with FCV advanced at each step. The intermediate upgrade runs on an isolated Docker volume because the available 8.3 patch rejects the Ubuntu 26 kernel installed on the cluster. MongoDB 9.0.4 was separately tested on the cluster's kernel.

Scheduled imports are suspended during migration. The source is locked against writes with `fsyncLock`; reads remain available. Database Tools 100.20.0 is used for both dump and restore. On the VPS, use the official Ubuntu 22.04 x86_64 tools: the tools bundled in the MongoDB 9 image require a newer CPU ISA than this host provides. The server binary itself runs successfully.

The upgraded database uses `mongodb-data-v9-skycat-pvc` on SkyCat. Production uses `Recreate` to ensure only one database process mounts its data volume. Memory requests protect MongoDB from being treated as a BestEffort pod during host memory pressure; its WiredTiger cache is bounded at 0.375 GiB (384 MiB) after search queries were changed to use index metadata instead of fetching every matching disclosure.

The original `mongodb-data-pvc` and private migration archive directory on SkyLion were retired after a newer encrypted backup was downloaded from Google Drive and fully restored locally. Recovery now uses a completed encrypted backup, restored into an isolated MongoDB 9 database before any production cutover. Backup archives contain application data and administrator password hashes; keep them private and do not commit them to Git.

Before enabling writes, verify all application collection counts and index definitions, run full collection validation, test the backend against the migrated database, and check public current and historical searches. Resume both import CronJobs only after verification.

For a production recovery, suspend imports and stop application writes first. Restore and verify the selected backup in a new MongoDB 9 volume, then commit the intended volume change to `k8s/mongodb.yaml` and let ArgoCD sync. ArgoCD self-healing will revert an uncommitted manual Deployment patch. Never mount the MongoDB 9 volume in an older binary. Restart the backend if needed and verify search before resuming imports. Reconcile writes made after the selected backup before using it as production.

## Verification on November 6, 2026

The migration preserves 1,390,257 PWD cases, 693,228 PERM cases, one administrator, one import catalog, eight import runs, fourteen import source records, and an empty import lock collection: 2,083,509 documents in total. All 35 original index definitions are retained, including compound key order. Restore reports zero document failures; collection counts, sampled document SHA-256 checksums, and full collection validation pass on both the isolated upgraded copy and the restored server. The 30 backend tests pass on Node 24 with MongoDB 9 and the updated driver, including the deployed backend tested against the restored server before cutover. Current searches, 2010 PWD and 2008 PERM search counts, historical details, and employer filters match the source database.

## Operational notes

During preparation, additional diagnostic shells exhausted SkyLion's small memory budget and the kernel killed the original BestEffort MongoDB pod. It recovered before a new consistent backup was taken. The restore was moved to SkyCat and temporary swap was used during recovery and removed after successful cutover. Keep diagnostic shells and database copies off the control-plane host when possible. Run administrative verification through a private SSH tunnel with a local driver instead of concurrent server-side Mongo shells. Full validation of this database can take several minutes on the worker. The production Deployment now has explicit memory requests and a limit. Both import CronJobs are pinned to SkyCat, with each importer limited to one CPU and 1 GiB; MongoDB has a 1536 MiB memory limit. This leaves the control-plane host free of database and import workloads.

## Local development

Fresh Docker Compose deployments use MongoDB 9.0.4. An existing `mongodb_data` volume from 8.2 must be backed up and migrated through 8.3 before starting 9.0; changing the image tag alone does not migrate FCV. Preserve the old volume until the upgraded copy has passed verification.

## References

- [MongoDB lifecycle schedule](https://www.mongodb.com/legal/support-policy/lifecycles)
- [Upgrade 8.2 standalone to 8.3](https://www.mongodb.com/docs/manual/release-notes/8.3-upgrade-standalone/)
- [Upgrade 8.3 standalone to 9.0](https://www.mongodb.com/docs/manual/release-notes/9.0-upgrade-standalone/)
- [MongoDB 9.0 release notes](https://www.mongodb.com/docs/manual/release-notes/9.0/)
- [Database Tools restore compatibility](https://www.mongodb.com/docs/database-tools/mongorestore/mongorestore-behavior-access-usage/)
