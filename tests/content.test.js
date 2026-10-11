const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../scripts/content.js'), 'utf8');
const SECRET = 'synthetic page key';
const OTHER = 'replacement page key';
function harness({ data = { lockSecret: SECRET, lockCache: 'synthetic-cache' }, handlers = {}, fault = null, transport = null } = {}) {
    const events = {};
    const trace = [];
    const messages = [];
    const domValues = [];
    let finished;
    const done = new Promise(resolve => { finished = resolve; });
    let element;
    const document = {
        documentElement: { appendChild(node) { element = node; } },
        getElementById: () => element ?? null,
        createElement: () => ({ setAttribute(key, value) { this[key] = value; domValues.push(value); } })
    };
    const defaults = {
        migrateLegacy: async key => {
            if (typeof key !== 'string' || !key || key === 'null' || !key.trim()) throw { code: 'INVALID_LEGACY_KEY' };
            h.durable = key;
            return { verified: true, keyId: 'synthetic-id' };
        },
        canCleanupLegacy: async () => false,
        getKeyStatus: async () => ({ ready: true, keyId: 'synthetic-id' })
    };
    const chrome = { runtime: {
        id: 'extension-id', lastError: null,
        sendMessage(request, callback) {
            messages.push(request);
            if (transport === 'throw') throw Error('Disconnected');
            Promise.resolve().then(() => (handlers[request.func] || defaults[request.func])(...request.params)).then(value => {
                if (transport === 'lastError') chrome.runtime.lastError = { message: 'Disconnected' };
                callback(transport === 'noResponse' ? undefined : { ok: true, value });
                chrome.runtime.lastError = null;
            }, error => callback({ ok: false, error: { code: error.code || 'STORAGE_ERROR' } }));
        }
    } };
    function storageOp(method, key) {
        trace.push({ method, key });
        const matched = fault && (!fault.method || fault.method === method) && (!fault.key || fault.key === key) && (!fault.index || fault.index === trace.length);
        if (matched && !fault.after) throw Error('Synthetic storage SecurityError');
        const result = data[key] ?? null;
        if (method === 'removeItem') delete data[key];
        if (matched && fault.after) throw Error('Synthetic interrupted cleanup');
        return result;
    }
    const window = {
        localStorage: { getItem: key => storageOp('getItem', key), removeItem: key => storageOp('removeItem', key) },
        addEventListener(name, handler) { events[name] = handler; },
        dispatchEvent(event) {
            const status = element?.['data-key-state'];
            if (status && JSON.parse(status).state !== 'pending') finished(JSON.parse(status));
            return true;
        }
    };
    const h = { data, messages, trace, domValues, done, durable: null, events, status: () => JSON.parse(element['data-key-state']) };
    vm.runInNewContext(source, { chrome, window, document, Event, setTimeout, clearTimeout, console });
    return h;
}

test('verified automatic copy retains source and cache until explicit cleanup approval', async () => {
    const h = harness(); const status = await h.done;
    assert.equal(h.durable, SECRET);
    assert.equal(h.data.lockSecret, SECRET);
    assert.equal(h.data.lockCache, 'synthetic-cache');
    assert.equal(status.state, 'ready'); assert.equal(status.cleanupPending, true);
    assert(!h.trace.some(x => x.method === 'removeItem'));
});

test('approved cleanup removes cache first, exact verified key last', async () => {
    const h = harness({ handlers: { canCleanupLegacy: async () => true } });
    const status = await h.done;
    assert.equal(status.cleanupPending, false);
    assert.equal(h.durable, SECRET);
    assert.deepEqual(h.data, {});
    assert.deepEqual(h.trace.filter(x => x.method === 'removeItem').map(x => x.key), ['lockCache', 'lockSecret']);
    for (const value of h.domValues) assert(!value.includes(SECRET));
    assert.deepEqual(h.messages.map(x => x.func), ['migrateLegacy', 'canCleanupLegacy']);
});

test('every localStorage read/remove interruption is conservative and restart-retry safe', async t => {
    const baseline = harness({ handlers: { canCleanupLegacy: async () => true } }); await baseline.done;
    for (let index = 1; index <= baseline.trace.length; index++) {
        for (const after of [false, true]) {
            await t.test(`storage ${index} ${after ? 'after' : 'before'}`, async () => {
                const data = { lockSecret: SECRET, lockCache: 'synthetic-cache' };
                const first = harness({ data, fault: { index, after }, handlers: { canCleanupLegacy: async () => true } });
                assert.equal((await first.done).state, 'error');
                if (!data.lockSecret) assert.equal(first.durable, SECRET, 'source gone only after durable verification');
                else assert.equal(data.lockSecret, SECRET);
                const retry = harness({ data, handlers: { canCleanupLegacy: async () => true } });
                assert.equal((await retry.done).state, 'ready');
                assert.equal(data.lockSecret, undefined);
            });
        }
    }
});

test('changed legacy value before cleanup is preserved, never replaced or deleted', async () => {
    const data = { lockSecret: SECRET, lockCache: 'synthetic-cache' };
    const h = harness({ data, handlers: { canCleanupLegacy: async () => { data.lockSecret = OTHER; return true; } } });
    const status = await h.done;
    assert.equal(status.state, 'error'); assert.equal(status.code, 'LEGACY_KEY_CHANGED');
    assert.equal(data.lockSecret, OTHER); assert.equal(data.lockCache, 'synthetic-cache');
    assert.equal(h.durable, SECRET);
});

test('source replacement after cache removal is detected before key removal', async () => {
    const data = { lockSecret: SECRET };
    Object.defineProperty(data, 'lockCache', { configurable: true, get() { data.lockSecret = OTHER; return 'cache'; } });
    const h = harness({ data, handlers: { canCleanupLegacy: async () => true } });
    const status = await h.done;
    assert.equal(status.code, 'LEGACY_KEY_CHANGED');
    assert.equal(data.lockSecret, OTHER);
});

test('no-response, disconnection, rejected and malformed verification never delete source', async () => {
    for (const transport of ['lastError', 'noResponse', 'throw']) {
        const h = harness({ transport });
        assert.equal((await h.done).state, 'error'); assert.equal(h.data.lockSecret, SECRET);
    }
    for (const result of [null, {}, { verified: false }, { verified: true }, { verified: true, keyId: 42 }]) {
        const h = harness({ handlers: { migrateLegacy: async () => result } });
        assert.equal((await h.done).state, 'error'); assert.equal(h.data.lockSecret, SECRET);
    }
    const h = harness({ handlers: { migrateLegacy: async () => { throw { code: 'KEY_CONFLICT' }; } } });
    assert.equal((await h.done).code, 'KEY_CONFLICT'); assert.equal(h.data.lockSecret, SECRET);
});

test('lost acknowledgement after durable save leaves source for idempotent retry', async () => {
    const data = { lockSecret: SECRET, lockCache: 'cache' };
    const first = harness({ data, transport: 'noResponse' });
    await first.done;
    assert.equal(first.durable, SECRET); assert.equal(data.lockSecret, SECRET);
    const retry = harness({ data });
    const status = await retry.done;
    assert.equal(retry.durable, SECRET); assert.equal(status.cleanupPending, true);
});

test('missing source never deletes orphan recovery cache under an unrelated key', async () => {
    const data = { lockCache: 'only-surviving-recovery-material' };
    const h = harness({ data }); const status = await h.done;
    assert.equal(status.recoveryPending, true);
    assert.equal(status.cleanupPending, false);
    assert.equal(data.lockCache, 'only-surviving-recovery-material');
    assert(!h.messages.some(x => x.func === 'migrateLegacy'));
});

test('empty, null-string and whitespace legacy values stay intact for recovery', async () => {
    for (const value of ['', 'null', ' ']) {
        const h = harness({ data: { lockSecret: value } });
        assert.equal((await h.done).state, 'error'); assert.equal(h.data.lockSecret, value);
    }
});

test('truthy malformed cleanup response never authorizes deletion', async () => {
    const h = harness({ handlers: { canCleanupLegacy: async () => ({ approved: true }) } });
    assert.equal((await h.done).cleanupPending, true); assert.equal(h.data.lockSecret, SECRET);
});

test('new installations only request status, never generate or send a page key', async () => {
    const h = harness({ data: {}, handlers: { getKeyStatus: async () => ({ ready: false, keyId: null }) } });
    assert.equal((await h.done).state, 'missing');
    assert.deepEqual(h.messages.map(x => x.func), ['getKeyStatus']);
    assert.deepEqual(h.data, {});
});
