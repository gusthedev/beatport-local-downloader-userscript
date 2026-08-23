const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const loaderSource = fs.readFileSync(
    path.join(__dirname, '..', 'beatport-local-loader.user.js'),
    'utf8',
);
const realCoreSource = fs.readFileSync(
    path.join(__dirname, '..', 'beatport-local-hazel.user.js'),
    'utf8',
);

const STORAGE = {
    source: 'beatportLoader.sharedCore.source.v1',
    fallback: 'beatportLoader.sharedCore.fallbackSource.v1',
    etag: 'beatportLoader.sharedCore.etag.v1',
    lastAttempt: 'beatportLoader.sharedCore.lastAttempt.v1',
    rejected: 'beatportLoader.sharedCore.rejectedSignature.v1',
    localOnly: 'beatportLoader.localOnly.v1',
};

function core(version, body = '') {
    return `// ==UserScript==
// @name         Beatport Local FLAC Download (Hazel)
// @namespace    local.beatportdl.hazel
// @version      ${version}
// @description  Loader test fixture
// ${'validated fixture '.repeat(70)}
// ==/UserScript==
globalThis.__beatportCoreRuns = [...(globalThis.__beatportCoreRuns || []), '${version}'];
${body}
globalThis[Symbol.for('tm.beatportdl.local.instance')] = { version: '${version}' };`;
}

function runLoader({ storageValues = {}, response = null, requestFailure = '' } = {}) {
    const storage = new Map(Object.entries(storageValues));
    const requests = [];
    const menus = new Map();
    const alerts = [];
    const context = {
        Date,
        Element: class {},
        HTMLAnchorElement: class {},
        URL,
        __TM_BEATPORTDL_TEST_MODE__: { skipStart: true },
        cancelAnimationFrame() {},
        clearTimeout() {},
        console: { error() {}, info() {}, warn() {} },
        document: {},
        location: { href: 'https://www.beatport.com/' },
        requestAnimationFrame() { return 1; },
        setTimeout() { return 1; },
        window: { alert: (message) => alerts.push(String(message)) },
        GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        GM_setValue: (key, value) => storage.set(key, value),
        GM_deleteValue: (key) => storage.delete(key),
        GM_registerMenuCommand: (label, callback) => menus.set(label, callback),
        GM_setClipboard() {},
        GM_xmlhttpRequest(request) {
            requests.push(request);
            if (requestFailure === 'network') request.onerror(new Error('offline'));
            else if (requestFailure === 'timeout') request.ontimeout();
            else if (response) request.onload(response);
        },
    };
    context.globalThis = context;
    vm.runInNewContext(loaderSource, context, { filename: 'beatport-local-loader.user.js' });
    return { alerts, context, menus, requests, storage };
}

test('cold first install validates, caches, and starts the core once', () => {
    const source = core('1.6.0');
    const harness = runLoader({
        response: {
            status: 200,
            responseText: source,
            responseHeaders: 'etag: "core-160"\r\n',
        },
    });

    assert.deepEqual(Array.from(harness.context.__beatportCoreRuns), ['1.6.0']);
    assert.equal(harness.storage.get(STORAGE.source), source);
    assert.equal(harness.storage.get(STORAGE.etag), '"core-160"');
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].url.includes('?'), false);
    assert.equal(harness.requests[0].headers['Cache-Control'], undefined);
});

test('cold first install can validate and start the real published-core candidate', () => {
    const harness = runLoader({
        response: {
            status: 200,
            responseText: realCoreSource,
            responseHeaders: 'etag: "real-core"\r\n',
        },
    });

    assert.equal(typeof harness.context.__TM_BEATPORTDL_TEST_HOOKS__.getBeatportMediaUrl, 'function');
    assert.equal(harness.storage.get(STORAGE.source), realCoreSource);
    assert.equal(harness.requests.length, 1);
});

test('fresh cache starts synchronously without a GitHub request', () => {
    const source = core('1.5.3');
    const harness = runLoader({
        storageValues: {
            [STORAGE.source]: source,
            [STORAGE.lastAttempt]: Date.now(),
        },
    });

    assert.deepEqual(Array.from(harness.context.__beatportCoreRuns), ['1.5.3']);
    assert.equal(harness.requests.length, 0);
});

test('a warm update is cached for the next page without double execution', () => {
    const current = core('1.5.3');
    const next = core('1.6.0');
    const harness = runLoader({
        storageValues: {
            [STORAGE.source]: current,
            [STORAGE.etag]: '"core-153"',
            [STORAGE.lastAttempt]: 0,
        },
        response: {
            status: 200,
            responseText: next,
            responseHeaders: 'ETag: "core-160"\r\n',
        },
    });

    assert.deepEqual(Array.from(harness.context.__beatportCoreRuns), ['1.5.3']);
    assert.equal(harness.storage.get(STORAGE.source), next);
    assert.equal(harness.storage.get(STORAGE.fallback), current);
    assert.equal(harness.requests[0].headers['If-None-Match'], '"core-153"');
});

test('network failure leaves the valid cached core active', () => {
    const current = core('1.5.3');
    const harness = runLoader({
        storageValues: {
            [STORAGE.source]: current,
            [STORAGE.lastAttempt]: 0,
        },
        requestFailure: 'network',
    });

    assert.deepEqual(Array.from(harness.context.__beatportCoreRuns), ['1.5.3']);
    assert.equal(harness.storage.get(STORAGE.source), current);
});

test('runtime failure restores and executes the rollback core', () => {
    const broken = core('1.6.0', "throw new Error('runtime failure');");
    const fallback = core('1.5.3');
    const harness = runLoader({
        storageValues: {
            [STORAGE.source]: broken,
            [STORAGE.fallback]: fallback,
            [STORAGE.lastAttempt]: Date.now(),
        },
    });

    assert.deepEqual(Array.from(harness.context.__beatportCoreRuns), ['1.6.0', '1.5.3']);
    assert.equal(harness.storage.get(STORAGE.source), fallback);
    assert.equal(harness.storage.has(STORAGE.fallback), false);
    assert.equal(harness.storage.has(STORAGE.rejected), true);
});

test('loader update metadata points to the loader, never the shared core', () => {
    const metadata = loaderSource.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/)?.[0] || '';
    assert.match(metadata, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/gusthedev\/beatport-local-downloader-userscript\/main\/beatport-local-loader\.user\.js/);
    assert.match(metadata, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/gusthedev\/beatport-local-downloader-userscript\/main\/beatport-local-loader\.user\.js/);
    assert.doesNotMatch(metadata, /@(updateURL|downloadURL).*beatport-local-hazel\.user\.js/);
});

test('manual update bypasses local caches', () => {
    const current = core('1.6.0');
    const harness = runLoader({
        storageValues: {
            [STORAGE.source]: current,
            [STORAGE.etag]: '"core-160"',
            [STORAGE.lastAttempt]: Date.now(),
        },
    });
    harness.menus.get('Check for shared-core updates now')();
    const request = harness.requests.at(-1);
    assert.match(request.url, /\?tm_refresh=\d+$/);
    assert.equal(request.headers['Cache-Control'], 'no-cache');
    request.onload({ status: 304, responseHeaders: '' });
});

test('local-only routing can be toggled immediately and persists', () => {
    const harness = runLoader({
        storageValues: {
            [STORAGE.source]: core('1.8.0'),
            [STORAGE.lastAttempt]: Date.now(),
        },
    });
    assert.equal(harness.context.BEATPORTDL_CONFIG.localOnly, false);
    harness.menus.get('Toggle local-only downloads')();
    assert.equal(harness.context.BEATPORTDL_CONFIG.localOnly, true);
    assert.equal(harness.storage.get(STORAGE.localOnly), true);
    harness.menus.get('Toggle local-only downloads')();
    assert.equal(harness.context.BEATPORTDL_CONFIG.localOnly, false);
});

test('non-initializing core is rejected instead of being marked active', () => {
    const silent = core('1.7.0').replace(
        "globalThis[Symbol.for('tm.beatportdl.local.instance')] = { version: '1.7.0' };",
        ''
    );
    const harness = runLoader({
        storageValues: {
            [STORAGE.source]: silent,
            [STORAGE.lastAttempt]: Date.now(),
        },
    });
    assert.equal(harness.storage.has(STORAGE.source), false);
    assert.equal(harness.context.__beatportCoreRuns[0], '1.7.0');
});
