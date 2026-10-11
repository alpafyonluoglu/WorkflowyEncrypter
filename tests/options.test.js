const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../options/options.js'), 'utf8');
const ACTIONS = {SET_KEY: 'setLockKey', MOVE_KEY: 'migrateLockKey', OPEN_WORKFLOWY: 'openWorkflowy', WELCOME: 'welcome'};
const emptyStatus = () => ({ready: false, keyId: null, hasPreviousKeys: false});
const savedStatus = () => ({ready: true, keyId: 'synthetic-key-one', hasPreviousKeys: false});

class Element {
    constructor(tag, fragment = false) {
        this.tagName = tag;
        this.fragment = fragment;
        this.children = [];
        this.parentNode = null;
        this.textContent = '';
        this.value = '';
        this.style = {};
        this.attributes = {};
        this.listeners = {};
        this.classes = new Set();
        this.classList = {add: (...names) => names.forEach(name => this.classes.add(name))};
    }
    appendChild(child) {
        if (child.fragment) {
            for (const node of [...child.children]) this.appendChild(node);
            child.children = [];
            return child;
        }
        if (child.parentNode) {
            child.parentNode.children = child.parentNode.children.filter(node => node !== child);
        }
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    replaceChildren(...children) {
        for (const child of this.children) child.parentNode = null;
        this.children = [];
        for (const child of children) this.appendChild(child);
    }
    set innerHTML(value) {
        this.replaceChildren();
        this.html = value;
    }
    get innerHTML() { return this.html || ''; }
    get isConnected() { return this.root === true || Boolean(this.parentNode?.isConnected); }
    setAttribute(key, value) { this.attributes[key] = value; }
    setAttributeNS(_, key, value) { this.setAttribute(key, value); }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    querySelector(selector) {
        for (const child of this.children) {
            const matches = selector.startsWith('#') ? child.id === selector.slice(1)
                : selector.startsWith('.') ? child.classes.has(selector.slice(1))
                : child.tagName === selector;
            if (matches) return child;
            const found = child.querySelector(selector);
            if (found) return found;
        }
        return null;
    }
}

function harness({handlers = {}, popupResult = 3, manualTimers = false, runtimeFailure = null, noReply = false, throwOnSend = false} = {}) {
    const body = new Element('body');
    body.root = true;
    const contentRoot = new Element('div');
    contentRoot.id = 'content';
    body.appendChild(contentRoot);
    const top = new Element('div');
    top.id = 'top';
    body.appendChild(top);
    const calls = [];
    const popups = [];
    const timers = new Map();
    let lastErrorReads = 0;
    let nextTimer = 0;
    let reloads = 0;
    const defaults = {
        getConstant: () => ACTIONS,
        getKeyStatus: () => emptyStatus(),
        takeOptionsAction: () => [null, null],
        saveKey: () => ({keyId: 'synthetic-new-key', changed: true}),
        clearCache: () => null,
        approveLegacyCleanup: () => ({approved: true})
    };
    const runtime = {
        getURL: value => 'chrome-extension://synthetic/' + value,
        get lastError() { lastErrorReads++; return runtimeFailure; },
        sendMessage(message, callback) {
            calls.push(message);
            if (throwOnSend) throw new Error('Synthetic transport error');
            if (noReply) return;
            const handler = handlers[message.func] || defaults[message.func];
            if (!handler) throw new Error('Unexpected RPC');
            Promise.resolve().then(() => handler(...message.params)).then(value => {
                if (value?.envelope) callback(value.envelope);
                else if (value?.noResponse) callback(undefined);
                else callback({ok: true, value});
            }, error => callback({ok: false, error: {code: error.code, message: 'Never display this synthetic raw error'}}));
        }
    };
    class Popup {
        static OUTCOMES = {CANCEL: 0, COMPLETE: 3};
        async preload() {}
        async open(config) {
            popups.push(config);
            return typeof popupResult === 'function' ? popupResult(config) : popupResult;
        }
    }
    const context = vm.createContext({
        chrome: {runtime},
        document: {
            body,
            getElementById: id => body.querySelector('#' + id),
            createElement: tag => new Element(tag),
            createElementNS: (_, tag) => new Element(tag),
            createDocumentFragment: () => new Element('fragment', true)
        },
        window: {location: {reload: () => reloads++, replace: url => calls.push({redirect: url})}},
        Popup,
        PopupTemplates: {confirm: (title, text, confirmText) => ({title, text, confirmText})},
        fetch: async () => ({text: async () => ''}),
        setTimeout: manualTimers ? (fn, delay) => { const id = ++nextTimer; timers.set(id, {fn, delay}); return id; } : setTimeout,
        clearTimeout: manualTimers ? id => timers.delete(id) : clearTimeout
    });
    vm.runInContext(source + '\n;globalThis.api = {ExtensionGateway, content, pageManager, c};', context);
    // Navigation and rendering tests keep the real async PageManager; only the
    // decorative breadcrumb HTML and infinite banner animation are omitted.
    vm.runInContext('pageManager.updateTopBar = () => {}; animator.bannerAnim = () => {};', context);
    return {context, api: context.api, body, contentRoot, calls, popups, timers,
        get lastErrorReads() { return lastErrorReads; }, get reloads() { return reloads; }};
}

async function form(h, status) {
    if (status) throw new Error('Pass status via the RPC handler');
    await h.api.content.loadSetKeyContent(h.contentRoot);
    return {
        input: h.contentRoot.querySelector('input'),
        button: h.contentRoot.querySelector('button'),
        message: h.contentRoot.querySelector('.node-input-subtext')
    };
}
function fail(code) { const error = new Error('Synthetic failure'); error.code = code; throw error; }
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('key input starts blank, masked, and reads only key status', async () => {
    const h = harness({handlers: {getKeyStatus: savedStatus}});
    const f = await form(h);
    assert.equal(f.input.value, '');
    assert.equal(f.input.type, 'password');
    assert.equal(f.input.autocomplete, 'new-password');
    assert.deepEqual(h.calls.map(call => call.func), ['getKeyStatus']);
});

test('new key is saved once through the verified background API without page broadcast', async () => {
    const h = harness();
    const f = await form(h);
    f.input.value = 'synthetic key with spaces';
    await f.button.listeners.click();
    const saves = h.calls.filter(call => call.func === 'saveKey');
    assert.equal(saves.length, 1);
    assert.deepEqual(Array.from(saves[0].params), ['synthetic key with spaces', null, false]);
    assert.equal(h.popups.length, 0);
    assert.equal(f.input.value, '');
    assert.match(f.message.textContent, /saved and verified.*Reload every open Workflowy tab/);
    assert.deepEqual(h.calls.map(call => call.func), ['getKeyStatus', 'saveKey']);
});

test('existing key requires an explicit warning and confirmed replacement', async () => {
    const h = harness({handlers: {getKeyStatus: savedStatus}});
    const f = await form(h);
    f.input.value = 'synthetic replacement';
    await f.button.listeners.click();
    assert.equal(h.popups.length, 1);
    assert.match(h.popups[0].text, /encrypted nodes still need their previous key/);
    assert.match(h.popups[0].text, /retained locally.*recovery/);
    assert.deepEqual(Array.from(h.calls.find(call => call.func === 'saveKey').params), ['synthetic replacement', 'synthetic-key-one', true]);
});

test('cancel or close replacement confirmation causes no write', async () => {
    for (const outcome of [0, undefined]) {
        const h = harness({handlers: {getKeyStatus: savedStatus}, popupResult: () => outcome});
        const f = await form(h);
        f.input.value = 'synthetic replacement';
        await f.button.listeners.click();
        assert.equal(h.calls.some(call => call.func === 'saveKey'), false);
        assert.equal(f.input.value, 'synthetic replacement');
        assert.equal(f.button.disabled, false);
    }
});

test('blank or null placeholder keys are not submitted', async () => {
    const h = harness();
    const f = await form(h);
    for (const invalid of ['', '  ', 'null']) {
        f.input.value = invalid;
        await f.button.listeners.click();
        assert.match(f.message.textContent, /valid, non-empty/);
    }
    assert.equal(h.calls.some(call => call.func === 'saveKey'), false);
});

test('repeated clicks cannot race confirmation or save', async () => {
    let finishConfirmation;
    const h = harness({handlers: {getKeyStatus: savedStatus}, popupResult: () => new Promise(resolve => { finishConfirmation = resolve; })});
    const f = await form(h);
    f.input.value = 'synthetic replacement';
    const firstClick = f.button.listeners.click();
    await f.button.listeners.click();
    assert.equal(h.popups.length, 1);
    assert.equal(f.button.disabled, true);
    finishConfirmation(3);
    await firstClick;
    assert.equal(h.calls.filter(call => call.func === 'saveKey').length, 1);
});

test('a stale key failure requires fresh status and a separate new confirmation', async () => {
    let reads = 0;
    let saves = 0;
    const h = harness({handlers: {
        getKeyStatus: () => ({...savedStatus(), keyId: ++reads === 1 ? 'synthetic-old' : 'synthetic-current'}),
        saveKey: () => ++saves === 1 ? fail('KEY_CHANGED') : {keyId: 'synthetic-next', changed: true}
    }});
    const f = await form(h);
    f.input.value = 'synthetic replacement';
    await f.button.listeners.click();
    assert.match(f.message.textContent, /changed in another tab/);
    assert.equal(f.button.textContent, 'Refresh key status');
    await f.button.listeners.click();
    assert.equal(saves, 1);
    assert.equal(f.button.textContent, 'Save');
    await f.button.listeners.click();
    assert.equal(saves, 2);
    assert.equal(h.popups.length, 2);
    assert.equal(h.calls.filter(call => call.func === 'saveKey')[1].params[1], 'synthetic-current');
});

test('storage failure never displays success or raw error text', async () => {
    const h = harness({handlers: {saveKey: () => fail('STORAGE_VERIFY_FAILED')}});
    const f = await form(h);
    f.input.value = 'synthetic secret';
    await f.button.listeners.click();
    assert.match(f.message.textContent, /Could not verify the save/);
    assert.doesNotMatch(f.message.textContent, /saved and verified|raw error|synthetic secret/);
    assert.equal(f.button.textContent, 'Refresh key status');
});

test('malformed successful save result is treated as an uncertain outcome', async () => {
    const h = harness({handlers: {saveKey: () => ({changed: true})}});
    const f = await form(h);
    f.input.value = 'synthetic key';
    await f.button.listeners.click();
    assert.doesNotMatch(f.message.textContent, /saved and verified/);
    assert.equal(f.button.textContent, 'Refresh key status');
});

test('RPC unwraps envelopes and rejects errors without disclosing raw text', async () => {
    const h = harness({handlers: {getKeyStatus: () => fail('KEY_RECORD_INVALID')}});
    await assert.rejects(h.api.ExtensionGateway.call('getKeyStatus'), error => error.code === 'KEY_RECORD_INVALID' && !error.message.includes('raw error'));
    assert.equal(h.lastErrorReads, 1);
});

test('RPC consumes runtime.lastError and rejects unavailable background', async () => {
    const h = harness({runtimeFailure: {message: 'Synthetic disconnected worker'}});
    await assert.rejects(h.api.ExtensionGateway.call('getKeyStatus'), error => error.code === 'RPC_UNAVAILABLE');
    assert.equal(h.lastErrorReads, 1);
});

test('RPC rejects no response, raw non-envelope replies, and thrown transport errors', async () => {
    for (const h of [
        harness({handlers: {getKeyStatus: () => ({noResponse: true})}}),
        harness({handlers: {getKeyStatus: () => ({envelope: {ready: true}})}}),
        harness({throwOnSend: true})
    ]) {
        await assert.rejects(h.api.ExtensionGateway.call('getKeyStatus'), error => ['RPC_NO_RESPONSE', 'RPC_UNAVAILABLE'].includes(error.code));
    }
});

test('RPC timeout is finite and exactly 30 seconds', async () => {
    const h = harness({noReply: true, manualTimers: true});
    const pending = h.api.ExtensionGateway.call('getKeyStatus');
    const failure = assert.rejects(pending, error => error.code === 'RPC_TIMEOUT');
    const [{fn, delay}] = h.timers.values();
    assert.equal(delay, 30000);
    fn();
    await failure;
    assert.equal(h.timers.size, 0);
});

test('migration view has no key field or raw key path and supports a safe status retry', async () => {
    const h = harness({handlers: {getKeyStatus: savedStatus}});
    await h.api.content.loadMoveKeyContent(h.contentRoot);
    assert.equal(h.contentRoot.querySelector('input'), null);
    const text = h.contentRoot.children.map(child => child.children[0]?.innerHTML || '').join(' ');
    assert.match(text, /Reopening Workflowy/);
    assert.match(text, /old website copy is kept until you explicitly approve/);
    assert.match(text, /Do not clear Workflowy's website data/);
    await h.contentRoot.querySelector('button').listeners.click();
    assert.deepEqual(h.calls.map(call => call.func), ['getKeyStatus']);
    assert.match(h.contentRoot.children[2].textContent, /A key is ready/);
});

test('options action is consumed through a dedicated action API with no raw argument', async () => {
    const h = harness({handlers: {takeOptionsAction: () => [ACTIONS.MOVE_KEY, 'ignored synthetic legacy data']}});
    await h.context.window.onload();
    assert.deepEqual(h.calls.map(call => call.func), ['getConstant', 'takeOptionsAction']);
    assert.equal(h.contentRoot.querySelector('input'), null);
    assert.doesNotMatch(h.contentRoot.children.map(child => child.textContent || child.innerHTML).join(' '), /ignored synthetic/);
});

test('startup failure shows a recoverable error instead of hanging forever', async () => {
    const h = harness({handlers: {getConstant: () => fail('STORAGE_ERROR')}});
    await h.context.window.onload();
    assert.match(h.contentRoot.children[0].textContent, /Options unavailable/);
    h.contentRoot.querySelector('button').listeners.click();
    assert.equal(h.reloads, 1);
});

test('navigation away during confirmation prevents the pending key change', async () => {
    let finishConfirmation;
    let isCurrent = true;
    const h = harness({handlers: {getKeyStatus: savedStatus}, popupResult: () => new Promise(resolve => { finishConfirmation = resolve; })});
    await h.api.content.loadSetKeyContent(h.contentRoot, () => isCurrent);
    h.contentRoot.querySelector('input').value = 'synthetic replacement';
    const pending = h.contentRoot.querySelector('button').listeners.click();
    isCurrent = false;
    finishConfirmation(3);
    await pending;
    assert.equal(h.calls.some(call => call.func === 'saveKey'), false);
});

test('late page loads cannot overwrite newer navigation', async () => {
    let finishStatus;
    const h = harness({handlers: {getKeyStatus: () => new Promise(resolve => { finishStatus = resolve; })}});
    const pending = h.api.pageManager.setPage(h.api.c.PAGES.SET_KEY);
    await nextTurn();
    await h.api.pageManager.setPage(h.api.c.PAGES.MOVE_KEY);
    finishStatus(savedStatus());
    await pending;
    assert.equal(h.contentRoot.children[0].textContent, 'Move Key');
    assert.equal(h.contentRoot.querySelector('input'), null);
});

test('Clear Cache describes memory only and uses its internal API after confirmation', async () => {
    const h = harness();
    await h.api.content.loadOptionsContent(h.contentRoot);
    const clearNode = h.contentRoot.children[2];
    await clearNode.listeners.click();
    assert.match(h.popups[0].text, /held in memory/);
    assert.match(h.popups[0].text, /saved key and previous keys are kept/);
    assert.deepEqual(h.calls.map(call => call.func), ['clearCache']);
});

test('options source contains no raw key reads, flag-based migration, or pre-save broadcast', () => {
    assert.doesNotMatch(source, /gateway\.(getStorage|setStorage|setVar|broadcastReload|loadSecret|isSecretLoaded|isValidSecret)\(/);
    assert.doesNotMatch(source, /actionArg|secretToMove|keyMoved|stored derived encryption keys/);
});


test('legacy cleanup is an explicit separate approval bound to current key status', async () => {
    const h = harness({handlers: {getKeyStatus: savedStatus}});
    await h.api.content.loadMoveKeyContent(h.contentRoot);
    const buttons = h.contentRoot.children[3].children;
    await buttons[1].listeners.click();
    assert.equal(h.popups.length, 1);
    assert.match(h.popups[0].text, /Close all other Workflowy tabs/);
    assert.match(h.popups[0].text, /reload the remaining tab/);
    assert.match(h.popups[0].text, /recovery key backed up/);
    assert.match(h.popups[0].text, /independent saved copy of your recovery key, leave cleanup pending/);
    assert.deepEqual(h.calls.map(call => call.func), ['getKeyStatus', 'approveLegacyCleanup']);
    assert.deepEqual(Array.from(h.calls[1].params), ['synthetic-key-one']);
    assert.match(h.contentRoot.children[2].textContent, /approved temporarily/);
    assert.match(h.contentRoot.children[2].textContent, /does not remove the website copy/);
});

test('canceling legacy cleanup leaves approval and website data untouched', async () => {
    const h = harness({handlers: {getKeyStatus: savedStatus}, popupResult: 0});
    await h.api.content.loadMoveKeyContent(h.contentRoot);
    await h.contentRoot.children[3].children[1].listeners.click();
    assert.deepEqual(h.calls.map(call => call.func), ['getKeyStatus']);
});

test('legacy cleanup cannot be approved without a ready saved key', async () => {
    const h = harness();
    await h.api.content.loadMoveKeyContent(h.contentRoot);
    await h.contentRoot.children[3].children[1].listeners.click();
    assert.equal(h.popups.length, 0);
    assert.equal(h.calls.some(call => call.func === 'approveLegacyCleanup'), false);
    assert.match(h.contentRoot.children[2].textContent, /verified key is needed first/);
});

test('legacy cleanup blockers remain recoverable and never claim cleanup finished', async () => {
    for (const [code, expected] of [
        ['OTHER_TABS_OPEN', /Keep exactly one Workflowy tab open/],
        ['MIGRATION_NOT_READY', /not ready for cleanup/],
        ['KEY_CHANGED', /saved key changed/],
        ['STORAGE_ERROR', /Could not verify cleanup approval/]
    ]) {
        const h = harness({handlers: {getKeyStatus: savedStatus, approveLegacyCleanup: () => fail(code)}});
        await h.api.content.loadMoveKeyContent(h.contentRoot);
        await h.contentRoot.children[3].children[1].listeners.click();
        assert.match(h.contentRoot.children[2].textContent, expected);
        assert.doesNotMatch(h.contentRoot.children[2].textContent, /Cleanup approved|raw error/);
    }
});
