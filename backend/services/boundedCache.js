// Small LRU with single-flight loads. Invalidating also fences in-flight results.
class BoundedCache {
    constructor({ capacity = 128, ttlMs = 30000 } = {}) {
        this.capacity = capacity;
        this.ttlMs = ttlMs;
        this.values = new Map();
        this.pending = new Map();
        this.generation = 0;
    }

    clear() {
        this.generation++;
        this.values.clear();
        this.pending.clear();
    }

    async get(key, load) {
        const entry = this.values.get(key);
        if (entry && entry.expires > Date.now()) {
            this.values.delete(key);
            this.values.set(key, entry);
            return entry.value;
        }
        this.values.delete(key);
        if (this.pending.has(key)) return this.pending.get(key);
        const generation = this.generation;
        const task = Promise.resolve().then(load).then(value => {
            if (generation === this.generation) {
                this.values.set(key, { value, expires: Date.now() + this.ttlMs });
                while (this.values.size > this.capacity) this.values.delete(this.values.keys().next().value);
            }
            return value;
        }).finally(() => {
            if (this.pending.get(key) === task) this.pending.delete(key);
        });
        // Do not retain an unbounded queue of unique requests.
        if (this.pending.size < this.capacity) this.pending.set(key, task);
        return task;
    }
}

module.exports = { BoundedCache };
