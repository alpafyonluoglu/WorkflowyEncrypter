const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fullSource = fs.readFileSync(path.join(__dirname, '../scripts/lock.js'), 'utf8');
const startupIndex = fullSource.lastIndexOf('(async () => {');
assert.ok(startupIndex > 0, 'Locate the optional UI/bootstrap IIFE explicitly');
// Unit-test the actual classes and synchronously installed fetch hook. Omit only
// the final startup IIFE, which waits for real browser DOM and extension startup.
// Release its read gate explicitly and replace decorative toast animations; no
// crypto, request processing, response processing, or RPC methods are replaced.
// The final startup-specific test runs the original IIFE as well, with no body.
const source = fullSource.slice(0, startupIndex);
const DOMAIN = 'https://workflowy.com';
const KEY_ID = 'synthetic-page-key';
const CIPHERTEXT = '_' + 'A'.repeat(64);
const NEVER_REPLY = Symbol('never reply');
const NO_RESPONSE = Symbol('no response');

class Element {
    constructor(tag = 'div') {
        this.tagName = tag;
        this.attributes = {};
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.textContent = '';
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) {
        for (const child of this.children) child.parentNode = null;
        this.children = [];
        this.append(...children);
    }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
    find(id) { return this.id === id ? this : this.children.map(child => child.find?.(id)).find(Boolean); }
}

function harness({state = {state: 'ready', keyId: KEY_ID}, handlers = {}, response, manualTimers = false, runStartup = false, beforeDOM = false, locationURL = DOMAIN + '/'} = {}) {
    const body = new Element('body');
    const bridge = new Element();
    bridge.id = 'wfe-internal-extensionId';
    bridge.setAttribute('value', 'synthetic-extension-id');
    bridge.setAttribute('data-key-state', JSON.stringify(state));
    body.appendChild(bridge);
    const nativeCalls = [];
    const rpcCalls = [];
    const timers = new Map();
    let timerId = 0;
    let lastErrorReads = 0;
    const origFetch = async (...args) => {
        nativeCalls.push(args);
        if (response) return typeof response === 'function' ? response(...args) : response;
        const url = typeof args[0] === 'string' ? args[0] : args[0].url;
        const result = new URL(url).pathname === '/get_tree_data' ? {items: []} : {results: []};
        return new Response(JSON.stringify(result), {status: 200, headers: {'Content-Type': 'application/json'}});
    };
    const defaults = {
        assertSession: () => true,
        encrypt: () => CIPHERTEXT,
        decrypt: () => 'synthetic decrypted text',
        getLockTag: () => '#private',
        getKeyStatus: () => ({ready: state.state === 'ready', keyId: state.keyId || null, hasPreviousKeys: false})
    };
    const runtime = {
        get lastError() { lastErrorReads++; return null; },
        sendMessage(extensionId, request, callback) {
            rpcCalls.push({...request, extensionId});
            const handler = handlers[request.func] || defaults[request.func];
            if (!handler) throw new Error('Unexpected synthetic RPC: ' + request.func);
            Promise.resolve().then(() => handler(...request.params)).then(value => {
                if (value === NEVER_REPLY) return;
                if (value === NO_RESPONSE) callback(undefined);
                else if (value?.envelope) callback(value.envelope);
                else callback({ok: true, value});
            }, error => callback({ok: false, error: {code: error.code || 'CRYPTO_ERROR', message: 'Synthetic RPC failure'}}));
        }
    };
    const documentListeners = new Map();
    const windowListeners = new Map();
    const window = {
        fetch: origFetch,
        addEventListener: (name, handler) => windowListeners.set(name, handler),
        dispatchEvent: event => windowListeners.get(event.type)?.(event),
        getComputedStyle: () => ({getPropertyValue: () => 'rgb(42, 49, 53)'})
    };
    const context = vm.createContext({
        window,
        document: {
            body: beforeDOM ? null : body,
            getElementById: id => body.find(id) || null,
            getElementsByTagName: name => name === 'body' ? [body] : [],
            createElement: name => new Element(name),
            createTextNode: text => Object.assign(new Element('text'), {textContent: text}),
            addEventListener: (name, handler) => documentListeners.set(name, handler)
        },
        location: {href: locationURL, origin: new URL(locationURL).origin, reload: () => {}},
        chrome: {runtime},
        Request, Response, Headers, URL, URLSearchParams, Event, AbortController,
        setTimeout: manualTimers ? (fn, delay) => { const id = ++timerId; timers.set(id, {fn, delay}); return id; } : setTimeout,
        clearTimeout: manualTimers ? id => timers.delete(id) : clearTimeout
    });
    vm.runInContext(source + `
        if (!${runStartup}) c.EXTENSION_ID = 'synthetic-extension-id';
        toast.show = async () => {};
        toast.hide = async () => {};
        if (!${runStartup}) { staller.ready(); encrypter.updateState(); }
        globalThis.testHooks = {
            encrypter, nodes, util, routes, api, c, ExtensionGateway,
            getState: () => ({cryptoFailure, migrationState, sessionKeyId}),
            updateState: () => encrypter.updateState()
        };
    `, context);
    if (runStartup) vm.runInContext(fullSource.slice(startupIndex), context);
    return {context, window, hooks: context.testHooks, body, bridge, nativeCalls, rpcCalls, timers,
        setState: next => { bridge.setAttribute('data-key-state', JSON.stringify(next)); context.testHooks.updateState(); },
        get lastErrorReads() { return lastErrorReads; }};
}
function fail(code) { const error = new Error('Synthetic failure'); error.code = code; throw error; }
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
    const deadline = Date.now() + 1000;
    while (!predicate() && Date.now() < deadline) await tick();
    assert.ok(predicate(), 'Expected synthetic pending stage was reached');
}
function formBody(operations = []) {
    return new URLSearchParams({
        client_id: 'synthetic-client', client_version: 'synthetic-version',
        crosscheck_user_id: 'synthetic-user',
        push_poll_data: JSON.stringify([{most_recent_operation_transaction_id: 'synthetic-transaction', operations}])
    }).toString();
}
function edit(description = 'SYNTHETIC PRIVATE TEXT', previous = 'SYNTHETIC PREVIOUS TEXT') {
    return {type: 'edit', data: {projectid: 'synthetic-child', description}, undo_data: {previous_description: previous}};
}
function lockNodes(h) {
    h.hooks.nodes.update('synthetic-parent', {name: '#private synthetic parent', parent: null});
    h.hooks.nodes.update('synthetic-child', {name: 'synthetic child', parent: 'synthetic-parent'});
}
function writeInit(body = formBody([edit()])) {
    return {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', 'WF_BUILD_DATE': 'synthetic-build', 'X-Synthetic': 'keep-me'}, credentials: 'include', body};
}
async function sentBody(h, index = 0) {
    const [input, init] = h.nativeCalls[index];
    return input instanceof Request ? input.clone().text() : String(init.body);
}

for (const variant of ['url-and-init', 'request', 'request-with-init-overrides']) {
    test(`fetch ${variant} encrypts before native fetch and preserves transport options`, async () => {
        const h = harness();
        lockNodes(h);
        const originalBody = formBody([edit()]);
        const init = {...writeInit(originalBody), cache: 'no-store', redirect: 'manual', referrerPolicy: 'no-referrer', mode: 'cors'};
        const request = new Request(DOMAIN + '/push_and_poll', init);
        if (variant === 'url-and-init') await h.window.fetch(request.url, init);
        else if (variant === 'request') await h.window.fetch(request);
        else await h.window.fetch(request, {credentials: 'same-origin', headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-Override': 'retained'}});
        assert.equal(h.nativeCalls.length, 1);
        const sent = h.nativeCalls[0][0];
        assert.equal(sent.method, 'POST');
        assert.equal(sent.credentials, variant === 'request-with-init-overrides' ? 'same-origin' : 'include');
        assert.equal(sent.cache, 'no-store');
        assert.equal(sent.redirect, 'manual');
        assert.equal(sent.referrerPolicy, 'no-referrer');
        assert.equal(sent.mode, 'cors');
        assert.equal(sent.headers.get(variant === 'request-with-init-overrides' ? 'X-Override' : 'X-Synthetic'), variant === 'request-with-init-overrides' ? 'retained' : 'keep-me');
        const body = await sentBody(h);
        const transformed = JSON.parse(new URLSearchParams(body).get('push_poll_data'))[0].operations[0];
        assert.equal(transformed.data.description, CIPHERTEXT);
        assert.equal(transformed.undo_data.previous_description, CIPHERTEXT);
        assert.doesNotMatch(body, /SYNTHETIC[+% ]PRIVATE|SYNTHETIC[+% ]PREVIOUS/);
        assert.equal(init.body, originalBody);
        assert.equal(request.bodyUsed, false);
        assert.equal(await request.clone().text(), originalBody);
    });
}

test('Request init body override is encrypted without changing either caller input', async () => {
    const h = harness(); lockNodes(h);
    const originalBody = formBody([edit('SYNTHETIC ORIGINAL')]);
    const overrideBody = formBody([edit('SYNTHETIC OVERRIDE')]);
    const request = new Request(DOMAIN + '/push_and_poll', writeInit(originalBody));
    const init = {body: overrideBody};
    await h.window.fetch(request, init);
    assert.equal(init.body, overrideBody);
    assert.equal(request.bodyUsed, false);
    assert.equal(await request.clone().text(), originalBody);
    assert.ok(h.rpcCalls.some(call => call.func === 'encrypt' && call.params[0] === 'SYNTHETIC OVERRIDE'));
    assert.equal(h.rpcCalls.some(call => call.func === 'encrypt' && call.params[0] === 'SYNTHETIC ORIGINAL'), false);
});

test('unrelated fetch forwards exact input/init and never parses the response', async () => {
    const response = new Response('not JSON', {headers: {'Content-Type': 'text/plain'}});
    response.clone = () => { throw new Error('Unrelated response must not be inspected'); };
    const h = harness({state: {state: 'pending'}, response});
    const input = 'https://example.invalid/synthetic';
    const init = {method: 'POST', body: 'opaque non-form body', credentials: 'omit'};
    assert.equal(await h.window.fetch(input, init), response);
    assert.equal(h.nativeCalls[0][0], input);
    assert.equal(h.nativeCalls[0][1], init);
    assert.equal(h.rpcCalls.length, 0);
});

for (const [label, handler] of [
    ['missing RPC response', () => NO_RESPONSE],
    ['key changed', () => fail('KEY_CHANGED')],
    ['malformed RPC envelope', () => ({envelope: {raw: 'invalid'}})]
]) {
    test(`encrypt ${label} blocks native fetch and preserves the caller Request`, async () => {
        const h = harness({handlers: {encrypt: handler}}); lockNodes(h);
        const originalBody = formBody([edit()]);
        const request = new Request(DOMAIN + '/push_and_poll', writeInit(originalBody));
        await assert.rejects(h.window.fetch(request));
        assert.equal(h.nativeCalls.length, 0);
        assert.equal(request.bodyUsed, false);
        assert.equal(await request.clone().text(), originalBody);
        assert.equal(request.headers.get('X-Synthetic'), 'keep-me');
    });
}

test('encrypt RPC timeout is bounded and sends no fallback plaintext', async () => {
    const h = harness({handlers: {encrypt: () => NEVER_REPLY}, manualTimers: true}); lockNodes(h);
    const originalBody = formBody([edit()]);
    const request = new Request(DOMAIN + '/push_and_poll', writeInit(originalBody));
    const rejected = assert.rejects(h.window.fetch(request), /did not respond/);
    const deadline = Date.now() + 1000;
    while (!h.rpcCalls.some(call => call.func === 'encrypt') && Date.now() < deadline) await tick();
    assert.ok(h.rpcCalls.some(call => call.func === 'encrypt'), 'Reach encryption before triggering its synthetic timeout');
    const pendingTimers = [...h.timers.values()];
    assert.equal(pendingTimers.length, 1);
    assert.equal(pendingTimers[0].delay, 30000);
    pendingTimers[0].fn();
    await rejected;
    assert.equal(h.nativeCalls.length, 0);
    assert.equal(request.bodyUsed, false);
    assert.equal(await request.clone().text(), originalBody);
});

for (const [label, value] of [['undefined', undefined], ['null', null], ['empty', ''], ['number', 7], ['object', {}], ['plaintext', 'synthetic plaintext'], ['short marker', '_bad']]) {
    test(`invalid encrypted result ${label} never reaches native fetch`, async () => {
        const h = harness({handlers: {encrypt: () => value}}); lockNodes(h);
        const init = writeInit();
        const original = init.body;
        await assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', init), /valid ciphertext/);
        assert.equal(h.nativeCalls.length, 0);
        assert.equal(init.body, original);
    });
}

test('a key change at the final whole-request barrier blocks the entire write', async () => {
    let assertions = 0;
    const h = harness({handlers: {assertSession: () => ++assertions === 4 ? fail('KEY_CHANGED') : true}}); lockNodes(h);
    await assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', writeInit()));
    assert.equal(h.rpcCalls.filter(call => call.func === 'encrypt').length, 2);
    assert.equal(h.nativeCalls.length, 0);
});

test('decrypt failure preserves every original ciphertext byte and pauses later writes', async () => {
    const h = harness({handlers: {decrypt: () => fail('DECRYPT_FAILED')}}); lockNodes(h);
    for (const ciphertext of ['_', '_synthetic-original-marker==', CIPHERTEXT]) {
        assert.equal(await h.hooks.encrypter.decrypt(ciphertext), ciphertext);
    }
    assert.equal(h.hooks.getState().cryptoFailure, true);
    await assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', writeInit()), /Writes are paused/);
    assert.equal(h.nativeCalls.length, 0);
});

test('invalid decrypted reply preserves ciphertext and sets the failure guard', async () => {
    const h = harness({handlers: {decrypt: () => null}});
    assert.equal(await h.hooks.encrypter.decrypt(CIPHERTEXT), CIPHERTEXT);
    assert.equal(h.hooks.getState().cryptoFailure, true);
});

test('empty decrypted text is preserved in tree response and node tracker', async () => {
    const h = harness({handlers: {decrypt: () => ''}, response: () => new Response(JSON.stringify({items: [{id: 'synthetic-node', nm: CIPHERTEXT, no: CIPHERTEXT}]}))});
    const response = await h.window.fetch(DOMAIN + '/get_tree_data');
    const json = await response.json();
    assert.equal(json.items[0].nm, '');
    assert.equal(json.items[0].no, '');
    assert.equal(h.hooks.nodes.get('synthetic-node', 'name'), '');
    assert.equal(h.hooks.nodes.get('synthetic-node', 'description'), '');
    assert.equal(h.hooks.getState().cryptoFailure, false);
});

test('empty private edit and undo fields are encrypted rather than dropped', async () => {
    const h = harness(); lockNodes(h);
    await h.window.fetch(DOMAIN + '/push_and_poll', writeInit(formBody([edit('', '')])));
    const encryptedInputs = h.rpcCalls.filter(call => call.func === 'encrypt').map(call => call.params[0]);
    assert.deepEqual(encryptedInputs, ['', '']);
    const operation = JSON.parse(new URLSearchParams(await sentBody(h)).get('push_poll_data'))[0].operations[0];
    assert.equal(operation.data.description, CIPHERTEXT);
    assert.equal(operation.undo_data.previous_description, CIPHERTEXT);
});

for (const state of [{state: 'missing'}, {state: 'pending'}, {state: 'error'}]) {
    test(`state ${state.state} blocks writes but permits read-only polling and tree reads`, async () => {
        const h = harness({state}); lockNodes(h);
        await assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', writeInit()), /Writes are paused/);
        assert.equal(h.nativeCalls.length, 0);
        const polled = await h.window.fetch(DOMAIN + '/push_and_poll', writeInit(formBody([])));
        assert.deepEqual(await polled.json(), {results: []});
        const tree = await h.window.fetch(DOMAIN + '/get_tree_data');
        assert.deepEqual(await tree.json(), {items: []});
        assert.equal(h.nativeCalls.length, 2);
        assert.equal(h.rpcCalls.some(call => ['assertSession', 'encrypt'].includes(call.func)), false);
    });
}

test('read-only polling without an operations property remains possible while migration is pending', async () => {
    const h = harness({state: {state: 'pending'}});
    const body = new URLSearchParams({push_poll_data: JSON.stringify([{most_recent_operation_transaction_id: 'synthetic'}])}).toString();
    await h.window.fetch(DOMAIN + '/push_and_poll', writeInit(body));
    assert.equal(h.nativeCalls.length, 1);
    assert.equal(h.rpcCalls.length, 0);
});

test('response transformation preserves status and unrelated headers, removing stale body headers', async () => {
    const h = harness({response: () => new Response(JSON.stringify({items: []}), {
        status: 202, statusText: 'Synthetic Accepted', headers: {'Content-Type': 'application/json', 'X-Synthetic': 'preserved', 'Content-Length': '999', 'Content-Encoding': 'gzip'}
    })});
    const response = await h.window.fetch(DOMAIN + '/get_tree_data');
    assert.equal(response.status, 202);
    assert.equal(response.statusText, 'Synthetic Accepted');
    assert.equal(response.headers.get('X-Synthetic'), 'preserved');
    assert.equal(response.headers.get('Content-Length'), null);
    assert.equal(response.headers.get('Content-Encoding'), null);
});

test('unparseable intercepted response is preserved and blocks subsequent writes', async () => {
    const original = 'synthetic original non-JSON response';
    const h = harness({response: () => new Response(original)}); lockNodes(h);
    const response = await h.window.fetch(DOMAIN + '/get_tree_data');
    assert.equal(await response.text(), original);
    assert.equal(h.hooks.getState().cryptoFailure, true);
    await assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', writeInit()));
    assert.equal(h.nativeCalls.length, 1);
});


test('empty new private node name and note are processed for encryption', async () => {
    const h = harness(); lockNodes(h);
    const operation = {type: 'bulk_create', data: {parentid: 'synthetic-parent', project_trees: JSON.stringify([{id: 'synthetic-new', nm: '', no: ''}])}};
    await h.window.fetch(DOMAIN + '/push_and_poll', writeInit(formBody([operation])));
    const encryptedInputs = h.rpcCalls.filter(call => call.func === 'encrypt').map(call => call.params[0]);
    assert.deepEqual(encryptedInputs, ['', '']);
    const sent = JSON.parse(new URLSearchParams(await sentBody(h)).get('push_poll_data'))[0].operations[0];
    const tree = JSON.parse(sent.data.project_trees)[0];
    assert.equal(tree.nm, CIPHERTEXT);
    assert.equal(tree.no, CIPHERTEXT);
});

test('caller abort reaches an in-flight transformed write and pauses later writes', async () => {
    const controller = new AbortController();
    let sent;
    const h = harness({response: request => {
        sent = request;
        return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), {once: true}));
    }}); lockNodes(h);
    const pending = h.window.fetch(DOMAIN + '/push_and_poll', {...writeInit(), signal: controller.signal});
    const rejected = assert.rejects(pending, /abort/i);
    await waitFor(() => sent !== undefined);
    assert.equal(sent.signal.aborted, false);
    controller.abort();
    await rejected;
    assert.equal(sent.signal.aborted, true);
    assert.equal(h.hooks.getState().cryptoFailure, true);
    await assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', writeInit()));
    assert.equal(h.nativeCalls.length, 1);
});

test('non-success responses are returned untouched without JSON parsing', async () => {
    const response = new Response('synthetic unavailable', {status: 503});
    const nativeClone = response.clone.bind(response);
    response.clone = () => {
        const cloned = nativeClone();
        cloned.json = () => { throw new Error('Must not JSON-parse failed response'); };
        return cloned;
    };
    response.json = () => { throw new Error('Must not JSON-parse failed response'); };
    const h = harness({response});
    assert.equal(await h.window.fetch(DOMAIN + '/get_tree_data'), response);
    assert.equal(h.hooks.getState().cryptoFailure, false);
});

test('actual startup releases reads before DOMContentLoaded when the key is unavailable', async () => {
    const h = harness({state: {state: 'missing'}, runStartup: true, beforeDOM: true});
    let timer;
    try {
        const response = await Promise.race([
            h.window.fetch(DOMAIN + '/get_tree_data'),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Read gate still depends on DOM readiness')), 500); })
        ]);
        assert.deepEqual(await response.json(), {items: []});
        assert.equal(h.context.document.body, null);
        assert.equal(h.nativeCalls.length, 1);
    } finally {
        clearTimeout(timer);
    }
});

for (const [label, setup, operation] of [
    ['unknown edit target', () => {}, () => edit()],
    ['missing ancestor', h => h.hooks.nodes.update('synthetic-child', {name: 'child', parent: 'synthetic-absent'}), () => edit()],
    ['missing parent metadata', h => h.hooks.nodes.update('synthetic-child', {name: 'child'}), () => edit()],
    ['cyclic ancestry', h => {
        h.hooks.nodes.update('synthetic-child', {name: 'child', parent: 'synthetic-cycle'});
        h.hooks.nodes.update('synthetic-cycle', {name: 'cycle', parent: 'synthetic-child'});
    }, () => edit()],
    ['unknown create parent', () => {}, () => ({type: 'bulk_create', data: {parentid: 'synthetic-absent', project_trees: JSON.stringify([{id: 'synthetic-new', nm: 'SYNTHETIC PRIVATE CREATE'}])}})],
    ['unknown move parent', h => h.hooks.nodes.update('synthetic-child', {name: 'child', parent: null}), () => ({type: 'bulk_move', data: {parentid: 'synthetic-absent', projectids_json: JSON.stringify(['synthetic-child'])}})],
    ['unknown move source', h => h.hooks.nodes.update('synthetic-parent', {name: 'parent', parent: null}), () => ({type: 'bulk_move', data: {parentid: 'synthetic-parent', projectids_json: JSON.stringify(['synthetic-absent'])}})],
    ['unsupported operation with text', () => {}, () => ({type: 'synthetic_future_operation', data: {name: 'SYNTHETIC PRIVATE UNKNOWN'}})],
    ['unexpected text in a simple operation', () => {}, () => ({type: 'complete', data: {projectid: 'synthetic-child', nested: {description: 'SYNTHETIC PRIVATE UNEXPECTED'}}})]
]) {
    test(`${label} fails closed before any native fetch`, async () => {
        const h = harness();
        setup(h);
        const originalBody = formBody([operation()]);
        const request = new Request(DOMAIN + '/push_and_poll', writeInit(originalBody));
        await assert.rejects(h.window.fetch(request), /ancestry|unsupported|Unexpected text/);
        assert.equal(h.nativeCalls.length, 0);
        assert.equal(request.bodyUsed, false);
        assert.equal(await request.clone().text(), originalBody);
        assert.equal(h.hooks.getState().cryptoFailure, true);
    });
}

test('known top-level unencrypted edit remains writable without unnecessary encryption', async () => {
    const h = harness();
    h.hooks.nodes.update('synthetic-child', {name: 'synthetic public root', parent: null});
    await h.window.fetch(DOMAIN + '/push_and_poll', writeInit(formBody([edit('SYNTHETIC PUBLIC NOTE', '')])));
    assert.equal(h.nativeCalls.length, 1);
    assert.equal(h.rpcCalls.some(call => call.func === 'encrypt'), false);
    const operation = JSON.parse(new URLSearchParams(await sentBody(h)).get('push_poll_data'))[0].operations[0];
    assert.equal(operation.data.description, 'SYNTHETIC PUBLIC NOTE');
    assert.equal(operation.undo_data.previous_description, '');
});

test('nested internal encryption push retains build header and expected transport settings', async () => {
    const h = harness();
    h.hooks.nodes.update('synthetic-root', {name: 'synthetic root', parent: null});
    h.hooks.nodes.update('synthetic-child', {name: 'SYNTHETIC CHILD CONTENT', description: 'SYNTHETIC CHILD NOTE', parent: 'synthetic-root'});
    const operation = {type: 'edit', data: {projectid: 'synthetic-root', name: '#private synthetic root'}, undo_data: {previous_name: 'synthetic root'}};
    await h.window.fetch(DOMAIN + '/push_and_poll', writeInit(formBody([operation])));
    assert.equal(h.nativeCalls.length, 2);
    const [url, init] = h.nativeCalls[0];
    assert.equal(url, DOMAIN + '/push_and_poll');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('wf_build_date'), 'synthetic-build');
    assert.equal(headers.get('Accept'), 'application/json');
    assert.equal(headers.get('Content-Type'), 'application/x-www-form-urlencoded; charset=UTF-8');
    const data = new URLSearchParams(init.body);
    assert.equal(data.get('client_id'), 'synthetic-client');
    assert.equal(data.get('client_version'), 'synthetic-version');
    assert.equal(data.get('crosscheck_user_id'), 'synthetic-user');
    const child = JSON.parse(data.get('push_poll_data'))[0].operations[0];
    assert.equal(child.data.name, CIPHERTEXT);
    assert.equal(child.data.description, CIPHERTEXT);
    assert.equal(child.undo_data.previous_name, CIPHERTEXT);
    assert.equal(child.undo_data.previous_description, CIPHERTEXT);
    assert.doesNotMatch(init.body, /SYNTHETIC[+% ]CHILD/);
});


for (const failure of ['rejected', 'HTTP 500']) {
    test(`native write ${failure} prevents any later write`, async () => {
        const h = harness({response: () => {
            if (failure === 'rejected') throw new Error('Synthetic native write rejection');
            return new Response('synthetic rejected write', {status: 500});
        }}); lockNodes(h);
        if (failure === 'rejected') {
            await assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', writeInit()), /Synthetic native write rejection/);
        } else {
            const response = await h.window.fetch(DOMAIN + '/push_and_poll', writeInit());
            assert.equal(response.status, 500);
            assert.equal(await response.text(), 'synthetic rejected write');
        }
        assert.equal(h.hooks.getState().cryptoFailure, true);
        await assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', writeInit()), /Writes are paused/);
        assert.equal(h.nativeCalls.length, 1);
    });
}

test('an internal descendant HTTP 500 prevents the outer tag-change request', async () => {
    const h = harness({response: () => new Response('synthetic descendant failure', {status: 500})});
    h.hooks.nodes.update('synthetic-root', {name: 'synthetic root', parent: null});
    h.hooks.nodes.update('synthetic-child', {name: 'SYNTHETIC CHILD', parent: 'synthetic-root'});
    const operation = {type: 'edit', data: {projectid: 'synthetic-root', name: '#private synthetic root'}, undo_data: {previous_name: 'synthetic root'}};
    await assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', writeInit(formBody([operation]))), /descendant update was not confirmed/);
    assert.equal(h.nativeCalls.length, 1);
    assert.equal(typeof h.nativeCalls[0][0], 'string');
    const sent = JSON.parse(new URLSearchParams(h.nativeCalls[0][1].body).get('push_poll_data'))[0].operations[0];
    assert.equal(sent.data.projectid, 'synthetic-child');
    assert.equal(sent.data.name, CIPHERTEXT);
    assert.equal(h.hooks.getState().cryptoFailure, true);
    await assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', writeInit()));
    assert.equal(h.nativeCalls.length, 1);
});

test('a child edit racing a deferred parent lock change stays queued and encrypted', async () => {
    let releaseEncryption;
    let defer = true;
    const h = harness({handlers: {encrypt: () => {
        if (defer) {
            defer = false;
            return new Promise(resolve => { releaseEncryption = resolve; });
        }
        return CIPHERTEXT;
    }}});
    h.hooks.nodes.update('synthetic-root', {name: 'synthetic root', parent: null});
    h.hooks.nodes.update('synthetic-child', {name: 'SYNTHETIC EXISTING CHILD', description: 'SYNTHETIC EXISTING NOTE', parent: 'synthetic-root'});
    const parentOperation = {type: 'edit', data: {projectid: 'synthetic-root', name: '#private synthetic root'}, undo_data: {previous_name: 'synthetic root'}};
    const parentWrite = h.window.fetch(DOMAIN + '/push_and_poll', writeInit(formBody([parentOperation])));
    await waitFor(() => releaseEncryption !== undefined);
    const childWrite = h.window.fetch(DOMAIN + '/push_and_poll', writeInit(formBody([edit('SYNTHETIC RACING CHILD', 'SYNTHETIC EXISTING NOTE')])));
    await tick();
    await tick();
    assert.equal(h.nativeCalls.length, 0);
    assert.equal(h.rpcCalls.some(call => call.func === 'encrypt' && call.params[0] === 'SYNTHETIC RACING CHILD'), false);
    releaseEncryption(CIPHERTEXT);
    await Promise.all([parentWrite, childWrite]);
    assert.equal(h.nativeCalls.length, 3);
    const child = JSON.parse(new URLSearchParams(await sentBody(h, 2)).get('push_poll_data'))[0].operations[0];
    assert.equal(child.data.description, CIPHERTEXT);
    assert.equal(child.undo_data.previous_description, CIPHERTEXT);
    assert.ok(h.rpcCalls.some(call => call.func === 'encrypt' && call.params[0] === 'SYNTHETIC RACING CHILD'));
});

test('the current beta Workflowy origin receives the same guarded encryption behavior', async () => {
    const beta = 'https://beta.workflowy.com';
    const h = harness({locationURL: beta + '/synthetic'}); lockNodes(h);
    assert.equal(h.hooks.c.DOMAIN, beta);
    await h.window.fetch(beta + '/push_and_poll', writeInit());
    assert.equal(h.nativeCalls.length, 1);
    const sent = h.nativeCalls[0][0];
    assert.equal(sent.url, beta + '/push_and_poll');
    const operation = JSON.parse(new URLSearchParams(await sentBody(h)).get('push_poll_data'))[0].operations[0];
    assert.equal(operation.data.description, CIPHERTEXT);
    assert.ok(h.rpcCalls.some(call => call.func === 'assertSession'));
    const missing = harness({state: {state: 'pending'}, locationURL: beta + '/synthetic'}); lockNodes(missing);
    await assert.rejects(missing.window.fetch(beta + '/push_and_poll', writeInit()), /Writes are paused/);
    assert.equal(missing.nativeCalls.length, 0);
});

test('native network timeout aborts the request and pauses subsequent writes', async () => {
    let sent;
    const h = harness({manualTimers: true, response: request => {
        sent = request;
        return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), {once: true}));
    }}); lockNodes(h);
    const rejected = assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', writeInit()), /request timed out/);
    await waitFor(() => sent !== undefined);
    const pending = [...h.timers.values()];
    assert.equal(pending.length, 1);
    assert.equal(pending[0].delay, 30000);
    pending[0].fn();
    await rejected;
    assert.equal(sent.signal.aborted, true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.hooks.getState().cryptoFailure, true);
    await assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', writeInit()));
    assert.equal(h.nativeCalls.length, 1);
});

test('network timeout also covers a stalled response body and releases queued reads', async () => {
    let bodyStarted = false;
    let attempt = 0;
    const h = harness({manualTimers: true, response: request => {
        if (attempt++ > 0) return new Response(JSON.stringify({items: []}));
        const body = new ReadableStream({start(controller) {
            bodyStarted = true;
            request.signal.addEventListener('abort', () => controller.error(request.signal.reason), {once: true});
        }});
        return new Response(body);
    }}); lockNodes(h);
    const rejected = assert.rejects(h.window.fetch(DOMAIN + '/push_and_poll', writeInit()), /request timed out/);
    await waitFor(() => bodyStarted);
    const pending = [...h.timers.values()];
    assert.equal(pending.length, 1);
    assert.equal(pending[0].delay, 30000);
    pending[0].fn();
    await rejected;
    assert.equal(h.hooks.getState().cryptoFailure, true);
    assert.equal(h.timers.size, 0);
    const read = await h.window.fetch(DOMAIN + '/get_tree_data');
    assert.deepEqual(await read.json(), {items: []});
    assert.equal(h.nativeCalls.length, 2);
});
