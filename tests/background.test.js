const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json')));
const SECRET = 'synthetic legacy key 🧪';
const OTHER = 'synthetic replacement key';
const clone = value => value === undefined ? undefined : structuredClone(value);
const content = { id: 'extension-id', url: 'https://workflowy.com/', frameId: 0, tab: { id: 1 }, documentId: 'document-one' };
const options = { id: 'extension-id', url: 'chrome-extension://extension-id/options/options.html' };
const page = { url: 'https://workflowy.com/', frameId: 0, tab: { id: 1 }, documentId: 'document-one' };
function harness(persisted = {}) {
    const trace = [];
    let fault = null;
    const listeners = {};
    const chrome = {
        runtime: {
            id: 'extension-id', lastError: null,
            getURL: path => 'chrome-extension://extension-id/' + path.replace(/^\//, ''),
            getManifest: () => manifest,
            openOptionsPage: async () => {},
            onMessage: { addListener: fn => { listeners.internal = fn; } },
            onMessageExternal: { addListener: fn => { listeners.external = fn; } },
            onInstalled: { addListener: fn => { listeners.installed = fn; } }
        },
        tabs: { query: async () => clone(h.tabs) },
        storage: { local: {} }
    };
    function call(method, arg, callback) {
        trace.push({ method, arg: clone(arg) });
        const shouldFail = fault && (fault.index === trace.length || (fault.method === method && (!fault.key || (typeof arg === 'string' ? arg === fault.key : Object.hasOwn(arg, fault.key))))) ? fault : null;
        if (shouldFail) fault = null;
        queueMicrotask(() => {
            let result;
            const mutate = () => {
                if (method === 'get') result = Object.hasOwn(persisted, arg) ? { [arg]: clone(persisted[arg]) } : {};
                if (method === 'set') Object.assign(persisted, clone(arg));
                if (method === 'remove') delete persisted[arg];
            };
            if (!shouldFail || shouldFail.after) mutate();
            chrome.runtime.lastError = shouldFail ? { message: 'Synthetic storage fault' } : null;
            callback(result);
            chrome.runtime.lastError = null;
        });
    }
    for (const method of ['get', 'set', 'remove', 'setAccessLevel']) chrome.storage.local[method] = (arg, cb) => call(method, arg, cb);
    const context = vm.createContext({ chrome, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, URL, atob, btoa, setTimeout, clearTimeout, console });
    const h = {
        trace, persisted, context, tabs: [{ id: 1 }],
        fail: value => { fault = value; },
        rpc: (func, params = [], sender = content, internal = true) => new Promise(resolve => listeners[internal ? 'internal' : 'external']({ func, params }, sender, resolve)),
        raw: (request, sender = content, internal = true) => new Promise(resolve => listeners[internal ? 'internal' : 'external'](request, sender, resolve))
    };
    vm.runInContext(source + '\nglobalThis.core = {keyStore, cipher, storage, ensureInitialized};', context);
    h.core = context.core;
    return h;
}
async function success(promise) { const response = await promise; assert.equal(response.ok, true, JSON.stringify(response)); return response.value; }
async function failure(promise, code) { const response = await promise; assert.equal(response.ok, false); if (code) assert.equal(response.error.code, code); return response; }
async function setup(h, secret = SECRET) { return success(h.rpc('migrateLegacy', [secret])); }

test('migration persists verified key without exposing any secret in response', async () => {
    const h = harness();
    const result = await setup(h);
    assert.equal(result.verified, true);
    assert.equal(h.persisted.keyRecord.active.secret, SECRET);
    assert(!JSON.stringify(result).includes(SECRET));
    assert(h.trace.some(call => call.method === 'setAccessLevel' && call.arg.accessLevel === 'TRUSTED_CONTEXTS'));
    assert.deepEqual(Object.keys(h.persisted), ['keyRecord']);
});

test('all storage fault boundaries retain source semantics and resume idempotently after restart', async t => {
    const baseline = harness(); await setup(baseline);
    const operations = baseline.trace.slice();
    for (let index = 2; index <= operations.length; index++) {
        for (const after of [false, true]) {
            await t.test(`interrupt ${index} ${operations[index - 1].method} ${after ? 'after' : 'before'}`, async () => {
                const data = {};
                const h = harness(data);
                h.fail({ index, after });
                const first = await h.rpc('migrateLegacy', [SECRET]);
                assert.equal(first.ok, false);
                if (data.keyRecord) assert.equal(data.keyRecord.active.secret, SECRET);
                const restarted = harness(data);
                const result = await setup(restarted);
                assert.equal(result.verified, true);
                assert.equal(data.keyRecord.active.secret, SECRET);
                const repeat = await setup(restarted);
                assert.equal(repeat.keyId, result.keyId);
            });
        }
    }
});

test('transient access-level initialization failure can retry in same worker', async () => {
    const h = harness(); await success(h.rpc('getKeyStatus'));
    vm.runInContext('initialization = null;', h.context);
    h.fail({ method: 'setAccessLevel' });
    await failure(h.rpc('getKeyStatus'), 'STORAGE_ERROR');
    assert.equal((await success(h.rpc('getKeyStatus'))).ready, false);
});

test('parallel same-key imports converge to one durable key', async () => {
    const h = harness();
    const results = await Promise.all(Array.from({ length: 8 }, (_, n) => success(h.rpc('migrateLegacy', [SECRET], { ...content, tab: { id: n + 1 } }))));
    assert.equal(new Set(results.map(r => r.keyId)).size, 1);
    assert.equal(h.trace.filter(x => x.method === 'set' && x.arg.keyRecord).length, 1);
});

test('conflicting concurrent imports never overwrite either persisted winner', async () => {
    const h = harness();
    const results = await Promise.all([h.rpc('migrateLegacy', [SECRET]), h.rpc('migrateLegacy', [OTHER])]);
    assert.equal(results[0].ok, true); assert.equal(results[1].error.code, 'KEY_CONFLICT');
    assert.equal(h.persisted.keyRecord.active.secret, SECRET);
});

test('missing and invalid keys are not auto-generated', async () => {
    const h = harness();
    assert.equal((await success(h.rpc('getKeyStatus'))).ready, false);
    for (const value of [null, '', 'null', '  ', 42, {}, []]) await failure(h.rpc('migrateLegacy', [value]), 'INVALID_LEGACY_KEY');
    assert.equal(h.persisted.keyRecord, undefined);
});

test('old extension key upgrades only after verified storage and remains on failure', async () => {
    const data = { lockSecret: SECRET, derivedKeyCache: { recovery: 'synthetic-raw-derived-key' } };
    const h = harness(data);
    h.fail({ method: 'set', key: 'keyRecord' });
    await failure(h.rpc('getKeyStatus'), 'STORAGE_ERROR');
    assert.equal(data.lockSecret, SECRET);
    assert(data.derivedKeyCache);
    const status = await success(h.rpc('getKeyStatus'));
    assert.equal(status.ready, true);
    assert.equal(data.lockSecret, undefined);
    assert(data.derivedKeyCache, 'unused legacy cache must remain recoverable until user clears it');
});

test('conflicting old extension key is preserved and cannot silently be replaced', async () => {
    const h = harness(); await setup(h);
    h.persisted.lockSecret = OTHER;
    await failure(h.rpc('getKeyStatus'), 'KEY_CONFLICT');
    assert.equal(h.persisted.lockSecret, OTHER);
    assert.equal(h.persisted.keyRecord.active.secret, SECRET);
});

test('warm derived cache cannot validate a corrupted record secret', async () => {
    const h = harness(); await setup(h);
    h.persisted.keyRecord.active.secret = OTHER;
    await failure(h.rpc('getKeyStatus'), 'KEY_RECORD_INVALID');
});

test('wrong/malformed record cannot be overwritten by automatic migration', async () => {
    for (const record of [{}, { version: 2 }, { version: 1, active: null, previous: [] }]) {
        const h = harness({ keyRecord: record });
        await failure(h.rpc('migrateLegacy', [SECRET]), 'KEY_RECORD_INVALID');
        assert.deepEqual(h.persisted.keyRecord, record);
    }
});

test('exact legacy format decrypts an independent PBKDF2 fixture, including empty value', async () => {
    const h = harness(); const { keyId } = await setup(h);
    for (const text of ['', 'hello #private', 'Unicode 🌈\nline 2', '0']) {
        const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
        const iv = Uint8Array.from({ length: 12 }, (_, i) => 31 - i);
        const password = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), 'PBKDF2', false, ['deriveKey']);
        const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, password, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
        const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
        const fixture = '_' + Buffer.concat([Buffer.from(salt), Buffer.from(iv), Buffer.from(encrypted)]).toString('base64');
        const result = await success(h.rpc('decrypt', [fixture, keyId], page, false));
        assert.equal(result, text);
    }
});

test('new ciphertext round trips, uses fresh randomness, and empty plaintext is encrypted', async () => {
    const h = harness(); const { keyId } = await setup(h);
    const encrypted = await success(h.rpc('encrypt', ['', keyId], page, false));
    assert.equal(encrypted.length, 61);
    assert.equal(await success(h.rpc('decrypt', [encrypted, keyId], page, false)), '');
    const again = await success(h.rpc('encrypt', ['', keyId], page, false));
    assert.notEqual(encrypted, again);
    assert(!h.persisted.derivedKeyCache);
    assert.equal((await h.core.cipher.key(h.persisted.keyRecord.active, new Uint8Array(16))).extractable, false);
});

test('missing key, stale session, invalid payload and damaged ciphertext never return plaintext fallback', async () => {
    const h = harness();
    await failure(h.rpc('encrypt', ['PRIVATE PLAINTEXT', 'missing'], page, false), 'KEY_MISSING');
    const { keyId } = await setup(h);
    await failure(h.rpc('encrypt', ['PRIVATE PLAINTEXT', 'wrong'], page, false), 'KEY_CHANGED');
    await failure(h.rpc('encrypt', [null, keyId], page, false), 'INVALID_REQUEST');
    for (const malformed of ['_', '_bad', '_%%%%', '_' + 'A'.repeat(60)]) await failure(h.rpc('decrypt', [malformed, keyId], page, false));
    const encrypted = await success(h.rpc('encrypt', ['PRIVATE PLAINTEXT', keyId], page, false));
    const bytes = Buffer.from(encrypted.slice(1), 'base64'); bytes[40] ^= 1;
    const failed = await failure(h.rpc('decrypt', ['_' + bytes.toString('base64'), keyId], page, false), 'DECRYPT_FAILED');
    assert(!JSON.stringify(failed).includes('PRIVATE PLAINTEXT'));
});

test('wrong key fails authentication instead of stripping ciphertext marker', async () => {
    const first = harness(); const a = await setup(first);
    const encrypted = await success(first.rpc('encrypt', ['hello', a.keyId], page, false));
    const second = harness(); const b = await setup(second, OTHER);
    await failure(second.rpc('decrypt', [encrypted, b.keyId], page, false), 'DECRYPT_FAILED');
});

test('replacement needs confirmation and current id; previous keys survive restart', async () => {
    const h = harness(); const { keyId } = await setup(h);
    const oldCipher = await success(h.rpc('encrypt', ['old node', keyId], page, false));
    await failure(h.rpc('saveKey', [OTHER, keyId, false], options), 'CONFIRM_REPLACEMENT');
    await failure(h.rpc('saveKey', [OTHER, 'stale', true], options), 'KEY_CHANGED');
    const result = await success(h.rpc('saveKey', [OTHER, keyId, true], options));
    assert.notEqual(result.keyId, keyId);
    assert.equal(h.persisted.keyRecord.previous[0].secret, SECRET);
    await failure(h.rpc('encrypt', ['stale tab edit', keyId], page, false), 'KEY_CHANGED');
    const restarted = harness(h.persisted);
    assert.equal(await success(restarted.rpc('decrypt', [oldCipher, result.keyId], page, false)), 'old node');
    const restored = await success(restarted.rpc('saveKey', [SECRET, result.keyId, true], options));
    assert.equal(restored.keyId, keyId);
    assert.equal(h.persisted.keyRecord.previous.length, 1);
});

test('save interrupted after persisted write keeps both keys and reload detects new id', async () => {
    const h = harness(); const { keyId } = await setup(h);
    h.fail({ method: 'set', key: 'keyRecord', after: true });
    await failure(h.rpc('saveKey', [OTHER, keyId, true], options), 'STORAGE_ERROR');
    assert.equal(h.persisted.keyRecord.previous[0].secret, SECRET);
    assert.equal((await success(h.rpc('getKeyStatus'))).keyId, h.persisted.keyRecord.active.id);
});

test('page and content cannot read/write secrets, bypass blockers, clear cache, or approve cleanup', async () => {
    const h = harness(); await setup(h);
    for (const func of ['getStorage', 'setStorage', 'setVar', 'setBlocker', 'clearCache', 'saveKey', 'migrateLegacy', 'approveLegacyCleanup']) {
        await failure(h.rpc(func, [], page, false), 'FORBIDDEN');
        if (func !== 'migrateLegacy') await failure(h.rpc(func, [], content), 'FORBIDDEN');
    }
    await failure(h.rpc('getConstant', ['__proto__'], page, false), 'INVALID_REQUEST');
    await failure(h.rpc('getResUrl', ['/background.js'], page, false), 'INVALID_REQUEST');
    await failure(h.rpc('openOptionsPage', ['migrateLockKey', SECRET], page, false), 'INVALID_REQUEST');
});

test('sender identity, HTTPS, top-frame and options exact URL are enforced', async () => {
    const h = harness();
    const badSenders = [
        { ...content, id: 'other' }, { ...content, frameId: 1 }, { ...content, url: 'http://workflowy.com/' },
        { ...content, url: 'https://workflowy.com.evil.invalid/' }, { ...content, tab: null },
        { ...options, url: options.url + '?forged' }
    ];
    for (const sender of badSenders) await failure(h.rpc('getKeyStatus', [], sender), 'FORBIDDEN');
    for (const sender of [{ ...page, id: 'another-extension' }, { ...page, frameId: 2 }, { ...page, url: 'https://evil.invalid/' }])
        await failure(h.rpc('getKeyStatus', [], sender, false), 'FORBIDDEN');
    await failure(h.raw(null), 'INVALID_REQUEST');
    await failure(h.raw({ func: 'getKeyStatus', params: 'not-array' }), 'INVALID_REQUEST');
});

test('cleanup is explicit, bound to active key/tab/document/origin, rechecked and restart-safe', async () => {
    const h = harness(); const { keyId } = await setup(h);
    assert.equal(await success(h.rpc('canCleanupLegacy')), false);
    h.tabs.push({ id: 2 });
    await failure(h.rpc('approveLegacyCleanup', [keyId], options), 'OTHER_TABS_OPEN');
    h.tabs.pop();
    await success(h.rpc('approveLegacyCleanup', [keyId], options));
    assert.equal(await success(h.rpc('canCleanupLegacy')), true);
    assert.equal(await success(h.rpc('canCleanupLegacy', [], { ...content, documentId: 'different' })), false);
    assert.equal(await success(h.rpc('canCleanupLegacy', [], { ...content, url: 'https://beta.workflowy.com/' })), false);
    h.tabs.push({ id: 2 });
    assert.equal(await success(h.rpc('canCleanupLegacy')), false);
    const restarted = harness(h.persisted);
    await setup(restarted);
    assert.equal(await success(restarted.rpc('canCleanupLegacy')), false);
});

test('missing document identity or changed active key cannot authorize cleanup', async () => {
    const h = harness();
    const result = await success(h.rpc('migrateLegacy', [SECRET], { ...content, documentId: undefined }));
    await failure(h.rpc('approveLegacyCleanup', [result.keyId], options), 'MIGRATION_NOT_READY');
    await setup(h);
    await success(h.rpc('approveLegacyCleanup', [result.keyId], options));
    await success(h.rpc('saveKey', [OTHER, result.keyId, true], options));
    await failure(h.rpc('canCleanupLegacy'), 'KEY_CHANGED');
});


test('legacy options migration argument is archived before any navigation can overwrite it', async () => {
    const h = harness({optionsAction: ['migrateLockKey', SECRET]});
    const action = await success(h.rpc('takeOptionsAction', [], options));
    assert.equal(action[1], null);
    assert.equal(h.persisted.legacyOptionsActions[0][1], SECRET);
    assert.equal(h.persisted.optionsAction, undefined);
    h.persisted.optionsAction = ['migrateLockKey', OTHER];
    await success(h.rpc('openOptionsPage', ['setLockKey'], page, false));
    assert.equal(h.persisted.legacyOptionsActions.length, 2);
    assert.equal(h.persisted.optionsAction[1], null);
});

test('failed archive never destroys the legacy options key candidate', async () => {
    const h = harness({optionsAction: ['migrateLockKey', SECRET]});
    h.fail({method:'set', key:'legacyOptionsActions'});
    await failure(h.rpc('takeOptionsAction', [], options), 'STORAGE_ERROR');
    assert.equal(h.persisted.optionsAction[1], SECRET);
});

test('silent storage write loss is detected by readback before migration acknowledgement', async () => {
    const h = harness();
    const original = h.core.storage.set.bind(h.core.storage);
    h.core.storage.set = async (key, value) => { if (key !== 'keyRecord') await original(key, value); };
    await failure(h.rpc('migrateLegacy', [SECRET]), 'STORAGE_VERIFY_FAILED');
    assert.equal(h.persisted.keyRecord, undefined);
});

test('cleanup approval expires without transferring authority to a later attempt', async () => {
    const h = harness(); const {keyId} = await setup(h);
    await success(h.rpc('approveLegacyCleanup', [keyId], options));
    vm.runInContext('for (const grant of cleanupGrants.values()) grant.expires = Date.now() - 1;', h.context);
    assert.equal(await success(h.rpc('canCleanupLegacy')), false);
});

test('storage reads preserve false, zero and empty string rather than substitute defaults', async () => {
    const h = harness({syntheticFalse: false, syntheticZero: 0, syntheticEmpty: ''});
    assert.equal(await h.core.storage.get('syntheticFalse', true), false);
    assert.equal(await h.core.storage.get('syntheticZero', 9), 0);
    assert.equal(await h.core.storage.get('syntheticEmpty', 'fallback'), '');
});
