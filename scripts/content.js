// Isolated world only. Never put a key, verifier, or derived key in the DOM,
// a page message, a URL, or a MAIN-world function argument.
(() => {
    const MARKER = 'wfe-internal-extensionId';
    let inFlight = null;
    function rpc(func, ...params) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('RPC_TIMEOUT')), 30000);
            try {
                chrome.runtime.sendMessage({ func, params }, response => {
                    clearTimeout(timer);
                    if (chrome.runtime.lastError) return reject(new Error('RPC_UNAVAILABLE'));
                    if (!response || response.ok !== true) return reject(new Error(response?.error?.code || 'RPC_UNAVAILABLE'));
                    resolve(response.value);
                });
            } catch { clearTimeout(timer); reject(new Error('RPC_UNAVAILABLE')); }
        });
    }
    async function marker() {
        while (!document.documentElement) await new Promise(resolve => setTimeout(resolve, 0));
        let element = document.getElementById(MARKER);
        if (!element) {
            element = document.createElement('span');
            element.id = MARKER;
            element.hidden = true;
            document.documentElement.appendChild(element);
        }
        element.setAttribute('value', chrome.runtime.id);
        return element;
    }
    async function publish(status) {
        (await marker()).setAttribute('data-key-state', JSON.stringify(status));
        window.dispatchEvent(new Event('wfe-key-state'));
    }
    async function migrate() {
        try {
            await publish({ state: 'pending' });
            const legacy = window.localStorage.getItem('lockSecret');
            let status;
            let cleanupPending = false;
            let recoveryPending = false;
            if (legacy !== null) {
                // Never infer success from a flag, absence of an exception, or an in-memory key.
                const result = await rpc('migrateLegacy', legacy);
                if (result?.verified !== true || typeof result.keyId !== 'string') throw new Error('STORAGE_VERIFY_FAILED');
                cleanupPending = true;
                if ((await rpc('canCleanupLegacy')) === true) {
                    // Cache first: if removal fails the source key still marks a retryable migration.
                    if (window.localStorage.getItem('lockSecret') !== legacy) throw new Error('LEGACY_KEY_CHANGED');
                    window.localStorage.removeItem('lockCache');
                    if (window.localStorage.getItem('lockSecret') !== legacy) throw new Error('LEGACY_KEY_CHANGED');
                    window.localStorage.removeItem('lockSecret');
                    if (window.localStorage.getItem('lockSecret') !== null) throw new Error('LEGACY_KEY_CHANGED');
                    cleanupPending = false;
                }
                status = { ready: true, keyId: result.keyId };
            } else {
                status = await rpc('getKeyStatus');
                // An orphan cache may be the only recovery material for a different key.
                // Never destroy it merely because some extension key is usable.
                recoveryPending = window.localStorage.getItem('lockCache') !== null;
            }
            await publish({ state: status.ready ? 'ready' : 'missing', keyId: status.keyId, cleanupPending, recoveryPending });
        } catch (error) {
            // Error codes are fixed; secret values are never logged or reflected into page UI.
            const codes = ['KEY_CONFLICT', 'INVALID_LEGACY_KEY', 'LEGACY_KEY_CHANGED', 'STORAGE_ERROR', 'STORAGE_VERIFY_FAILED', 'KEY_RECORD_INVALID'];
            await publish({ state: 'error', code: codes.includes(error.message) ? error.message : 'MIGRATION_UNAVAILABLE' });
        }
    }
    function retry() {
        if (!inFlight) inFlight = migrate().finally(() => { inFlight = null; });
        return inFlight;
    }
    window.addEventListener('focus', retry);
    window.addEventListener('storage', event => { if (event.key === 'lockSecret' || event.key === 'lockCache') retry(); });
    window.addEventListener('wfe-retry-migration', retry);
    retry();
})();
