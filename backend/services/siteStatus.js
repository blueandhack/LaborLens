// Background data status for the administration page: the nightly refresh
// run (refresh-employers.js) and the summaries it maintains.
const { randomUUID } = require('node:crypto');
const { programs } = require('./searchConfig');
const { MAP_VERSION, MAP_PROGRAMS } = require('./map');
const { getUscisStatus } = require('./uscisH1b');
const { getI140Status } = require('./i140');

const HISTORY = 10, EVENT_INTERVAL_MS = 5000;

// Records one refresh run in discovery_state "refresh". Writes never fail the run.
function createRunRecorder(db, args) {
    const state = db.collection('discovery_state'), runId = randomUUID(), startedAt = new Date();
    const steps = [];
    let lastWrite = 0;
    const write = update => state.updateOne({ _id: 'refresh' }, update, { upsert: true })
        .catch(error => console.error('Refresh status update failed:', error.message));
    return {
        start: () => write({ $set: { running: true, runId, startedAt, args, step: null, steps, lastEvent: null,
            finishedAt: null, outcome: null, error: null, updatedAt: startedAt } }),
        step(name) {
            const now = new Date();
            if (steps.length) steps.at(-1).finishedAt = now;
            steps.push({ name, startedAt: now, finishedAt: null });
            return write({ $set: { step: name, steps, updatedAt: now } });
        },
        // Throttled: progress lines can arrive many times a second.
        event(value) {
            if (Date.now() - lastWrite < EVENT_INTERVAL_MS) return undefined;
            lastWrite = Date.now();
            return write({ $set: { lastEvent: { ...value, at: new Date() }, updatedAt: new Date() } });
        },
        finish(error) {
            const finishedAt = new Date();
            if (steps.length && !steps.at(-1).finishedAt) steps.at(-1).finishedAt = finishedAt;
            const outcome = error ? 'failed' : 'succeeded', message = error ? String(error.message || error).slice(0, 500) : null;
            return write({ $set: { running: false, step: null, steps, finishedAt, outcome, error: message, updatedAt: finishedAt },
                $push: { history: { $each: [{ runId, args, startedAt, finishedAt, outcome, error: message, steps: steps.map(step => step.name) }], $slice: -HISTORY } } });
        },
    };
}

async function getSiteStatus(db) {
    const state = db.collection('discovery_state');
    const [documents, lock, metas, insights, profiles, requests, counts, uscis, i140] = await Promise.all([
        state.find({ _id: { $in: ['refresh', 'map', 'employers', 'employer_identities', 'worksites'] } }, { maxTimeMS: 2000 }).toArray(),
        db.collection('discovery_locks').findOne({ _id: 'refresh' }, { maxTimeMS: 2000 }),
        db.collection('map_meta').find({}, { maxTimeMS: 2000 }).toArray(),
        db.collection('search_insights').find({}, { projection: { revision: 1, changedAt: 1, 'snapshot.generatedAt': 1, 'snapshot.revision': 1, 'snapshot.totalCount': 1 }, maxTimeMS: 2000 }).toArray(),
        db.collection('employer_profiles').estimatedDocumentCount(),
        db.collection('employer_profile_requests').countDocuments({}, { maxTimeMS: 2000 }),
        Promise.all(MAP_PROGRAMS.map(async program => [program, await db.collection(programs[program].collection).estimatedDocumentCount()])),
        getUscisStatus(db),
        getI140Status(db),
    ]);
    const byId = Object.fromEntries(documents.map(document => [document._id, document]));
    const meta = Object.fromEntries(metas.map(document => [document._id, document]));
    const revisions = Object.fromEntries(insights.map(document => [document._id, document]));
    const caseCounts = Object.fromEntries(counts);
    const leaseActive = Boolean(lock?.expiresAt && lock.expiresAt > new Date());
    const refresh = byId.refresh || null;
    return {
        generatedAt: new Date(),
        refresh: refresh && { ...refresh, _id: undefined, history: (refresh.history || []).slice().reverse(),
            // A run that stopped without recording its end (killed or evicted).
            interrupted: Boolean(refresh.running && !leaseActive) },
        leaseActive,
        map: MAP_PROGRAMS.map(program => {
            const build = byId.map?.programs?.[program] || null, built = meta[program] || null;
            const current = built && built.version === MAP_VERSION && built.source?.count === caseCounts[program]
                && built.source?.revision === (revisions[program]?.revision ?? null);
            return { program, cases: caseCounts[program], build: build && { ...build, interrupted: build.state === 'building' && !leaseActive },
                built: built && { updatedAt: built.updatedAt, total: built.total, located: built.located, metroLocated: built.metroLocated,
                    years: built.years?.length ? [built.years.at(-1).year, built.years[0].year] : null, occupations: built.occupations?.length ?? 0 },
                upToDate: Boolean(current) };
        }),
        employers: byId.employers ? { ready: Boolean(byId.employers.ready), building: Boolean(byId.employers.building), updatedAt: byId.employers.updatedAt || null,
            programs: byId.employers.programs || {} } : null,
        identities: byId.employer_identities ? { ready: Boolean(byId.employer_identities.ready), updatedAt: byId.employer_identities.updatedAt || null,
            identities: byId.employer_identities.identities ?? null, combined: byId.employer_identities.combined ?? null, feinLinks: byId.employer_identities.feinLinks ?? null } : null,
        worksites: byId.worksites?.programs || {},
        insights: MAP_PROGRAMS.map(program => {
            const row = revisions[program];
            return { program, generatedAt: row?.snapshot?.generatedAt || null, totalCount: row?.snapshot?.totalCount ?? null,
                current: Boolean(row?.snapshot && row.snapshot.revision === row.revision), changedAt: row?.changedAt || null };
        }),
        profiles: { cached: profiles, pending: requests },
        uscis,
        i140,
    };
}

module.exports = { createRunRecorder, getSiteStatus };
