// All key ownership and cryptography stay in trusted extension contexts.
// The page receives plaintext/ciphertext and opaque key IDs, never key material.
class WfeError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new WfeError(code, message); };
const c = Object.freeze({
    THEMES: { LIGHT: 'light', DARK: 'dark' },
    PRE_ENC_CHAR: '_', DEFAULT_LOCK_TAG: '#private',
    RELOAD_REASONS: { UPDATE: 'extensionUpdate', KEY_CHANGE: 'keyChange', TAG_CHANGE: 'tagChange' },
    ACTIONS: { SET_KEY: 'setLockKey', MOVE_KEY: 'migrateLockKey', OPEN_WORKFLOWY: 'openWorkflowy', WELCOME: 'welcome' }
});

class ExtensionStorage {
    call(method, argument) {
        return new Promise((resolve, reject) => {
            chrome.storage.local[method](argument, result => {
                const error = chrome.runtime.lastError;
                if (error) reject(new WfeError('STORAGE_ERROR', 'Extension storage is unavailable. Retry without clearing any stored keys.'));
                else resolve(result);
            });
        });
    }
    async get(key, fallback = null) {
        const result = await this.call('get', key);
        if (!result || typeof result !== 'object') fail('STORAGE_ERROR', 'Extension storage could not be read.');
        return Object.prototype.hasOwnProperty.call(result, key) ? result[key] : fallback;
    }
    async set(key, value) { await this.call('set', { [key]: value }); }
    async remove(key) { await this.call('remove', key); }
}
const storage = new ExtensionStorage();

class Cipher {
    cache = new Map();
    encode(bytes) { return btoa(Array.from(new Uint8Array(bytes), b => String.fromCharCode(b)).join('')); }
    decode(value) {
        if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
            fail('INVALID_CIPHERTEXT', 'Encrypted text has an invalid format. The original text has been preserved.');
        let bytes;
        try { bytes = Uint8Array.from(atob(value), ch => ch.charCodeAt(0)); }
        catch { fail('INVALID_CIPHERTEXT', 'Encrypted text has an invalid format.'); }
        if (bytes.length < 44 || this.encode(bytes) !== value)
            fail('INVALID_CIPHERTEXT', 'Encrypted text is incomplete. The original text has been preserved.');
        return bytes;
    }
    async key(entry, salt) {
        const id = entry.id + ':' + this.encode(salt);
        if (!this.cache.has(id)) {
            const promise = (async () => {
                const password = await crypto.subtle.importKey('raw', new TextEncoder().encode(entry.secret), 'PBKDF2', false, ['deriveKey']);
                return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, password,
                    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            })();
            this.cache.set(id, promise);
            promise.catch(() => this.cache.delete(id));
            // Non-extractable keys exist only for this worker lifetime. No raw key cache is persisted.
            if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value);
        }
        return this.cache.get(id);
    }
    async encrypt(text, entry) {
        if (typeof text !== 'string') fail('INVALID_REQUEST', 'Expected text to encrypt.');
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await this.key(entry, salt);
        const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
        const result = new Uint8Array(28 + data.length);
        result.set(salt); result.set(iv, 16); result.set(data, 28);
        return '_' + this.encode(result);
    }
    async decrypt(text, entry) {
        const data = this.decode(text.slice(1));
        const key = await this.key(entry, data.slice(0, 16));
        const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(16, 28) }, key, data.slice(28));
        return new TextDecoder('utf-8', { fatal: true }).decode(result);
    }
}
const cipher = new Cipher();

class KeyStore {
    tail = Promise.resolve();
    verified = new Map();
    exclusive(work) {
        const result = this.tail.then(work);
        this.tail = result.catch(() => {});
        return result;
    }
    validSecret(secret) { return typeof secret === 'string' && secret.trim().length > 0 && secret !== 'null'; }
    validateShape(record) {
        if (!record || record.version !== 1 || !record.active || !Array.isArray(record.previous))
            fail('KEY_RECORD_INVALID', 'The stored key record needs recovery. Do not clear extension storage.');
        const entries = [record.active, ...record.previous];
        const ids = new Set();
        for (const entry of entries) {
            if (!entry || !this.validSecret(entry.secret) || typeof entry.id !== 'string' || !entry.id ||
                typeof entry.probe !== 'string' || !entry.probe.startsWith('_') || ids.has(entry.id))
                fail('KEY_RECORD_INVALID', 'The stored key record needs recovery. Do not clear extension storage.');
            ids.add(entry.id);
        }
    }
    async validate(record) {
        this.validateShape(record);
        for (const entry of [record.active, ...record.previous]) {
            const fingerprint = JSON.stringify(entry);
            if (this.verified.get(entry.id) === fingerprint) continue;
            // Never validate changed persisted bytes with a key cached for an older secret.
            for (const id of cipher.cache.keys()) if (id.startsWith(entry.id + ':')) cipher.cache.delete(id);
            try {
                if (await cipher.decrypt(entry.probe, entry) !== 'Workflowy Encrypter key verification v1:' + entry.id) throw Error();
            } catch { fail('KEY_RECORD_INVALID', 'Stored key verification failed. Do not clear any stored keys.'); }
            this.verified.set(entry.id, fingerprint);
        }
        return record;
    }
    async entry(secret) {
        if (!this.validSecret(secret)) fail('INVALID_KEY', 'Enter a nonempty encryption key.');
        const entry = { id: crypto.randomUUID(), secret };
        entry.probe = await cipher.encrypt('Workflowy Encrypter key verification v1:' + entry.id, entry);
        return entry;
    }
    async commit(record) {
        // The whole keyring is one storage item: no flag can get ahead of its key.
        await storage.set('keyRecord', record);
        const persisted = await storage.get('keyRecord');
        if (JSON.stringify(persisted) !== JSON.stringify(record))
            fail('STORAGE_VERIFY_FAILED', 'The key could not be verified in extension storage. Keep the original key and retry.');
        // Verify from freshly persisted bytes, independently of in-memory derived keys.
        cipher.cache.clear(); this.verified.clear();
        return this.validate(persisted);
    }
    async read() {
        let record = await storage.get('keyRecord');
        const legacy = await storage.get('lockSecret');
        if (record !== null) await this.validate(record);
        if (legacy !== null) {
            if (!this.validSecret(legacy)) fail('INVALID_LEGACY_KEY', 'A legacy extension key is invalid. Its value has been preserved for recovery.');
            if (record && ![record.active, ...record.previous].some(entry => entry.secret === legacy))
                fail('KEY_CONFLICT', 'Different stored keys were found. Both have been preserved; resolve the conflict before editing.');
            if (!record) record = await this.commit({ version: 1, active: await this.entry(legacy), previous: [] });
            // Never remove a legacy copy until the exact value is in a verified record.
            if (await storage.get('lockSecret') === legacy) await storage.remove('lockSecret');
        }
        return record;
    }
    async status() {
        return this.exclusive(async () => {
            const record = await this.read();
            return { ready: record !== null, keyId: record?.active.id ?? null, hasPreviousKeys: !!record?.previous.length };
        });
    }
    async migrate(secret) {
        return this.exclusive(async () => {
            if (!this.validSecret(secret)) fail('INVALID_LEGACY_KEY', 'The legacy page key is invalid. It has not been removed.');
            let record = await this.read();
            if (record && record.active.secret !== secret)
                fail('KEY_CONFLICT', 'The page key differs from the extension key. Both copies have been preserved.');
            if (!record) record = await this.commit({ version: 1, active: await this.entry(secret), previous: [] });
            // Reread even on a retry. The acknowledgement must attest to persisted bytes now.
            const persisted = await storage.get('keyRecord');
            await this.validate(persisted);
            if (persisted.active.secret !== secret || persisted.active.id !== record.active.id)
                fail('KEY_CONFLICT', 'The stored key changed during migration. Retry without deleting the page key.');
            return { verified: true, keyId: persisted.active.id };
        });
    }
    async save(secret, expectedId, replacement = false) {
        return this.exclusive(async () => {
            if (!this.validSecret(secret)) fail('INVALID_KEY', 'Enter a nonempty encryption key.');
            const current = await this.read();
            if ((current?.active.id ?? null) !== expectedId)
                fail('KEY_CHANGED', 'The key changed in another tab. Review the current key status and try again.');
            if (current?.active.secret === secret) return { keyId: current.active.id, changed: false };
            if (current && replacement !== true)
                fail('CONFIRM_REPLACEMENT', 'Confirm the key change. The previous key will be retained for recovery.');
            const previous = current ? [current.active, ...current.previous] : [];
            // Re-selecting an archived key preserves its identity and avoids duplicate records.
            const active = previous.find(entry => entry.secret === secret) ?? await this.entry(secret);
            const record = await this.commit({ version: 1, active, previous: previous.filter(entry => entry.id !== active.id) });
            // This notice is advisory only. Cryptographic session checks enforce stale-tab safety.
            try { await storage.set('var_reloadBroadcast', { reason: c.RELOAD_REASONS.KEY_CHANGE, time: Date.now() }); } catch {}
            return { keyId: record.active.id, changed: true };
        });
    }
    async session(keyId) {
        return this.exclusive(async () => {
            const record = await this.read();
            if (!record) fail('KEY_MISSING', 'Set your key in the extension options before editing protected content.');
            if (typeof keyId !== 'string' || keyId !== record.active.id)
                fail('KEY_CHANGED', 'Your key changed. Reload Workflowy before making further edits.');
            return record;
        });
    }
    async encrypt(data, keyId) {
        const record = await this.session(keyId);
        return cipher.encrypt(data, record.active);
    }
    async decrypt(data, keyId) {
        if (typeof data !== 'string') fail('INVALID_REQUEST', 'Expected text to decrypt.');
        if (!data.startsWith('_')) return data;
        const record = await this.session(keyId);
        cipher.decode(data.slice(1));
        for (const entry of [record.active, ...record.previous]) {
            try { return await cipher.decrypt(data, entry); } catch {}
        }
        fail('DECRYPT_FAILED', 'This encrypted text could not be opened with your saved keys. The original text has been preserved.');
    }
}
const keyStore = new KeyStore();

const workflowyURL = value => {
    try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'workflowy.com' || url.hostname.endsWith('.workflowy.com')); }
    catch { return false; }
};
const trustedOptions = sender => sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL('options/options.html');
const trustedContent = sender => sender.id === chrome.runtime.id && sender.frameId === 0 && workflowyURL(sender.url) &&
    Number.isInteger(sender.tab?.id);
const trustedPage = sender => !sender.id && sender.frameId === 0 && workflowyURL(sender.url) && Number.isInteger(sender.tab?.id);
const migrations = new Map();
const cleanupGrants = new Map();
const migrationIdentity = sender => typeof sender.documentId === 'string' && sender.documentId
    ? `${sender.tab.id}:${sender.documentId}:${new URL(sender.url).origin}` : null;
async function onlyMigrationTab(tabId) {
    const tabs = await chrome.tabs.query({ url: ['*://*.workflowy.com/*'] });
    return tabs.length === 1 && tabs[0].id === tabId;
}
const resources = new Set(chrome.runtime.getManifest().web_accessible_resources.flatMap(item => item.resources));
const publicCalls = new Set(['encrypt', 'decrypt', 'getKeyStatus', 'assertSession', 'isSecretLoaded', 'getBlocker',
    'getConstant', 'getLockTag', 'getResUrl', 'getVar', 'openOptionsPage']);

async function preserveLegacyOptionsAction() {
    const action = await storage.get('optionsAction', [null, null]);
    if (Array.isArray(action) && action[0] === c.ACTIONS.MOVE_KEY && typeof action[1] === 'string' && action[1]) {
        const archived = await storage.get('legacyOptionsActions', []);
        if (!Array.isArray(archived)) fail('STORAGE_VERIFY_FAILED', 'Legacy recovery information needs attention.');
        if (!archived.some(item => JSON.stringify(item) === JSON.stringify(action))) {
            const next = [...archived, action];
            await storage.set('legacyOptionsActions', next);
            if (JSON.stringify(await storage.get('legacyOptionsActions')) !== JSON.stringify(next))
                fail('STORAGE_VERIFY_FAILED', 'Legacy recovery information could not be preserved.');
        }
    }
    return action;
}
async function openOptions(action) {
    if (action != null && ![c.ACTIONS.SET_KEY, c.ACTIONS.MOVE_KEY].includes(action)) fail('INVALID_REQUEST', 'Invalid options action.');
    await keyStore.exclusive(async () => {
        await preserveLegacyOptionsAction();
        await storage.set('optionsAction', [action ?? null, null]);
    });
    await chrome.runtime.openOptionsPage();
    return true;
}
async function dispatch(request, sender, internal) {
    await ensureInitialized();
    if (!request || typeof request.func !== 'string' || !Array.isArray(request.params) || request.params.length > 3)
        fail('INVALID_REQUEST', 'Invalid extension request.');
    const { func, params } = request;
    const options = internal && trustedOptions(sender);
    const content = internal && trustedContent(sender);
    if (internal ? !options && !content : !trustedPage(sender)) fail('FORBIDDEN', 'This caller is not permitted.');
    if (content) {
        if (func === 'migrateLegacy' && params.length === 1) {
            const result = await keyStore.migrate(params[0]);
            const identity = migrationIdentity(sender);
            if (identity) {
                for (const [previous, value] of migrations) {
                    if (value.tabId === sender.tab.id && previous !== identity) { migrations.delete(previous); cleanupGrants.delete(previous); }
                }
                migrations.set(identity, { tabId: sender.tab.id, keyId: result.keyId });
            }
            return result;
        }
        if (func === 'getKeyStatus' && params.length === 0) return keyStore.status();
        if (func === 'canCleanupLegacy' && params.length === 0) {
            const identity = migrationIdentity(sender);
            const grant = identity && cleanupGrants.get(identity);
            if (!grant || grant.expires < Date.now() || !await onlyMigrationTab(sender.tab.id)) return false;
            await keyStore.session(grant.keyId);
            return migrations.get(identity)?.keyId === grant.keyId;
        }
        fail('FORBIDDEN', 'This operation is unavailable to content scripts.');
    }
    if (!options && !publicCalls.has(func)) fail('FORBIDDEN', 'This operation is private to the extension.');
    switch (func) {
        case 'encrypt': if (params.length !== 2) break; return keyStore.encrypt(...params);
        case 'decrypt': if (params.length !== 2) break; return keyStore.decrypt(...params);
        case 'assertSession': if (params.length !== 1) break; await keyStore.session(params[0]); return true;
        case 'getKeyStatus': if (params.length !== 0) break; return keyStore.status();
        case 'isSecretLoaded': return (await keyStore.status()).ready;
        case 'getBlocker': return (await keyStore.status()).ready ? null : c.ACTIONS.SET_KEY;
        case 'getConstant': if (params.length === 1 && Object.prototype.hasOwnProperty.call(c, params[0])) return c[params[0]]; break;
        case 'getLockTag': return storage.get('lockTag', c.DEFAULT_LOCK_TAG);
        case 'getResUrl': if (params.length === 1 && resources.has(params[0])) return chrome.runtime.getURL(params[0]); break;
        case 'getVar': if (params[0] === 'reloadBroadcast') return storage.get('var_reloadBroadcast'); break;
        case 'openOptionsPage': if (params.length <= 1) return openOptions(params[0]); break;
        case 'approveLegacyCleanup':
            if (options && params.length === 1) {
                await keyStore.session(params[0]);
                const tabs = await chrome.tabs.query({ url: ['*://*.workflowy.com/*'] });
                if (tabs.length !== 1) fail('OTHER_TABS_OPEN', 'Close all other Workflowy tabs before finishing migration.');
                const current = Array.from(migrations.entries()).filter(([, item]) => item.tabId === tabs[0].id && item.keyId === params[0]);
                if (current.length !== 1) fail('MIGRATION_NOT_READY', 'Reload the remaining Workflowy tab, then review migration again.');
                cleanupGrants.set(current[0][0], { keyId: params[0], expires: Date.now() + 5 * 60 * 1000 });
                return { approved: true };
            }
            break;
        case 'saveKey': if (options && params.length === 3) return keyStore.save(...params); break;
        case 'takeOptionsAction':
            if (options && params.length === 0) {
                return keyStore.exclusive(async () => {
                    const value = await preserveLegacyOptionsAction();
                    await storage.remove('optionsAction');
                    return [Array.isArray(value) ? value[0] : null, null];
                });
            }
            break;
        case 'clearCache':
            if (options) { cipher.cache.clear(); return true; }
            break;
    }
    fail('INVALID_REQUEST', 'Unknown operation or invalid arguments.');
}
function listener(request, sender, respond, internal) {
    dispatch(request, sender, internal).then(value => respond({ ok: true, value }), error => respond({
        ok: false, error: { code: error instanceof WfeError ? error.code : 'CRYPTO_ERROR',
            message: error instanceof WfeError ? error.message : 'Encryption is unavailable. Your original data has not been sent. Retry or reload.' }
    }));
    return true;
}
// Register listeners synchronously so MV3 can wake the worker for every request.
chrome.runtime.onMessageExternal.addListener((request, sender, respond) => listener(request, sender, respond, false));
chrome.runtime.onMessage.addListener((request, sender, respond) => listener(request, sender, respond, true));
let initialization = null;
function ensureInitialized() {
    if (!initialization) {
        initialization = storage.call('setAccessLevel', { accessLevel: 'TRUSTED_CONTEXTS' }).catch(error => {
            initialization = null; // A transient error must be retryable without restarting Chrome.
            throw error;
        });
    }
    return initialization;
}
// Legacy derived-key caches are not read, but may be needed for manual recovery.
// They are retained for deliberate manual recovery; Clear Cache affects only memory.
ensureInitialized().catch(() => {});
chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') ensureInitialized().then(() => openOptions(c.ACTIONS.SET_KEY)).catch(() => {});
});
