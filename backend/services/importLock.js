const { randomUUID } = require('crypto');

const LEASE_MS = 5 * 60 * 1000;

async function acquireImportLock(db, label, { leaseMs = LEASE_MS, heartbeatMs = 30000, runId = null } = {}) {
    const locks = db.collection('import_locks');
    const owner = randomUUID();
    let expiresAt = new Date(Date.now() + leaseMs);
    try {
        await locks.findOneAndUpdate(
            { _id: 'case-import', expiresAt: { $lte: new Date() } },
            { $set: { owner, label, runId, expiresAt } },
            { upsert: true, returnDocument: 'after' },
        );
    } catch (error) {
        if (error.code === 11000) {
            const busy = new Error('Another data import or clear operation is running. Try again later.');
            busy.status = 409;
            throw busy;
        }
        throw error;
    }
    let lost;
    let renewing = Promise.resolve();
    const timer = setInterval(() => {
        renewing = renewing.then(async () => {
            const renewedUntil = new Date(Date.now() + leaseMs);
            const result = await locks.updateOne(
                { _id: 'case-import', owner, expiresAt: { $gt: new Date() } },
                { $set: { expiresAt: renewedUntil } },
            );
            if (!result.matchedCount) throw new Error('Import lease expired or was lost');
            expiresAt = renewedUntil;
        }).catch(error => { lost = error; });
    }, heartbeatMs);
    timer.unref();
    return {
        ensureActive() {
            if (lost) throw lost;
            if (Date.now() >= expiresAt.getTime()) throw new Error('Import lease expired');
        },
        async release() {
            clearInterval(timer);
            await renewing;
            await locks.deleteOne({ _id: 'case-import', owner });
        },
    };
}

module.exports = { acquireImportLock };
