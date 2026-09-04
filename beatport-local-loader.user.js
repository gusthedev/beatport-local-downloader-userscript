// ==UserScript==
// @name         Beatport Local Download Loader
// @namespace    local.beatportdl.hazel.loader
// @version      1.5.0
// @description  Loads the shared Beatport userscript maintained on GitHub.
// @author       Gustavo
// @match        https://www.beatport.com/*
// @match        https://beatport.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_removeValueChangeListener
// @grant        GM_addValueChangeListener
// @grant        GM_setClipboard
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/gusthedev/beatport-local-downloader-userscript/main/beatport-local-loader.user.js
// @downloadURL  https://raw.githubusercontent.com/gusthedev/beatport-local-downloader-userscript/main/beatport-local-loader.user.js
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const CONFIRM_LARGE_JOBS_KEY = 'beatportLoader.confirmLargeJobs.v1';
    const LOCAL_ONLY_KEY = 'beatportLoader.localOnly.v1';
    const modeListeners = new Set();
    function announceMode() { modeListeners.forEach(callback => callback()); }
    if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(LOCAL_ONLY_KEY, announceMode);
    }
    globalThis.BEATPORTDL_CONFIG = Object.freeze({
        get confirmLargeJobs() {
            return GM_getValue(CONFIRM_LARGE_JOBS_KEY, true) !== false;
        },
        setLocalOnly(value) {
            GM_setValue(LOCAL_ONLY_KEY, value === true);
            announceMode();
        },
        onModeChange(callback) { modeListeners.add(callback); },
        get localOnly() {
            return GM_getValue(LOCAL_ONLY_KEY, false) === true;
        },
    });

    const SHARED_SCRIPT_URL = 'https://raw.githubusercontent.com/gusthedev/beatport-local-downloader-userscript/main/beatport-local-hazel.user.js';
    const UPDATE_INTERVAL = 60 * 60 * 1000;
    const EMPTY_CACHE_RETRY_INTERVAL = 5 * 60 * 1000;
    const REQUEST_TIMEOUT = 15_000;
    const INSTANCE_KEY = Symbol.for('tm.beatportdl.local.instance');
    const STORAGE = Object.freeze({
        source: 'beatportLoader.sharedCore.source.v1',
        fallbackSource: 'beatportLoader.sharedCore.fallbackSource.v1',
        etag: 'beatportLoader.sharedCore.etag.v1',
        lastAttempt: 'beatportLoader.sharedCore.lastAttempt.v1',
        rejectedSignature: 'beatportLoader.sharedCore.rejectedSignature.v1',
        confirmLargeJobs: CONFIRM_LARGE_JOBS_KEY,
        localOnly: LOCAL_ONLY_KEY,
    });

    let activeSource = '';
    let updateInFlight = false;

    function metadataValue(source, key) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return String(source || '').match(new RegExp(`^//\\s*@${escapedKey}\\s+(.+?)\\s*$`, 'm'))?.[1] || '';
    }

    function sharedCoreVersion(source) {
        return metadataValue(source, 'version') || 'unknown version';
    }

    function isValidSharedCore(source) {
        if (typeof source !== 'string' || source.length < 1_000 || source.length > 500_000) return false;
        if (metadataValue(source, 'name') !== 'Beatport Local FLAC Download (Hazel)') return false;
        if (metadataValue(source, 'namespace') !== 'local.beatportdl.hazel') return false;
        if (!/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(metadataValue(source, 'version'))) return false;

        try {
            new Function(source);
            return true;
        } catch {
            return false;
        }
    }

    function sourceSignature(source) {
        let hash = 0x811c9dc5;
        for (let index = 0; index < source.length; index += 1) {
            hash ^= source.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
        }
        return `${source.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }

    function readCachedSource(key, label) {
        const source = GM_getValue(key, '');
        if (isValidSharedCore(source)) return source;
        if (source) {
            GM_deleteValue(key);
            console.warn(`[Beatport loader] Discarded an invalid cached ${label}.`);
        }
        return '';
    }

    function readCachedSources() {
        const primary = readCachedSource(STORAGE.source, 'shared core');
        if (!primary) GM_deleteValue(STORAGE.etag);
        const fallback = readCachedSource(STORAGE.fallbackSource, 'fallback core');
        return { primary, fallback: fallback === primary ? '' : fallback };
    }

    function executeSharedCore(source, label, { clearRejected = true } = {}) {
        if (globalThis[INSTANCE_KEY]) return true;
        if (activeSource || !isValidSharedCore(source)) return false;
        try {
            eval(`${source}\n//# sourceURL=beatport-local-hazel.user.js`);
            if (!globalThis[INSTANCE_KEY]) throw new Error('The shared core returned without initializing.');
            activeSource = source;
            // Starting an older working version must not pardon a rejected update.
            if (clearRejected && GM_getValue(STORAGE.rejectedSignature, '') === sourceSignature(source)) {
                GM_deleteValue(STORAGE.rejectedSignature);
            }
            return true;
        } catch (error) {
            GM_setValue(STORAGE.rejectedSignature, sourceSignature(source));
            console.error(`[Beatport loader] Could not start the ${label}.`, error);
            return false;
        }
    }

    function startCachedCore() {
        const { primary, fallback } = readCachedSources();

        if (primary && executeSharedCore(primary, 'cached shared core')) {
            return;
        }

        if (primary) {
            GM_deleteValue(STORAGE.source);
            GM_deleteValue(STORAGE.etag);
        }

        if (fallback && executeSharedCore(fallback, 'fallback shared core', { clearRejected: false })) {
            GM_setValue(STORAGE.source, fallback);
            GM_deleteValue(STORAGE.fallbackSource);
            GM_deleteValue(STORAGE.etag);
            console.warn(`[Beatport loader] Restored shared core ${sharedCoreVersion(fallback)} after the newer core failed to start.`);
        } else if (fallback) {
            GM_deleteValue(STORAGE.fallbackSource);
        }
    }

    function responseHeader(response, headerName) {
        const target = headerName.toLowerCase();
        for (const line of String(response.responseHeaders || '').split(/\r?\n/)) {
            const separator = line.indexOf(':');
            if (separator < 0 || line.slice(0, separator).trim().toLowerCase() !== target) continue;
            return line.slice(separator + 1).trim();
        }
        return '';
    }

    function notify(message) {
        window.alert(`[Beatport loader] ${message}`);
    }

    function cacheSharedCore(nextSource, previousSource, response) {
        if (previousSource && nextSource !== previousSource) {
            GM_setValue(STORAGE.fallbackSource, previousSource);
        }
        GM_setValue(STORAGE.source, nextSource);

        const nextEtag = responseHeader(response, 'etag');
        if (nextEtag) GM_setValue(STORAGE.etag, nextEtag);
        else GM_deleteValue(STORAGE.etag);
    }

    function checkForSharedCoreUpdate({ manual = false, executeIfEmpty = false } = {}) {
        if (updateInFlight) {
            if (manual) notify('An update check is already running.');
            return;
        }

        updateInFlight = true;
        GM_setValue(STORAGE.lastAttempt, Date.now());

        const { primary, fallback } = readCachedSources();
        const previousSource = primary || fallback;
        const etag = primary ? GM_getValue(STORAGE.etag, '') : '';
        const headers = etag ? { 'If-None-Match': etag } : {};
        if (manual) {
            headers['Cache-Control'] = 'no-cache';
            headers.Pragma = 'no-cache';
        }

        function fail(message, error) {
            updateInFlight = false;
            const suffix = activeSource || previousSource ? ' The cached core remains active.' : '';
            console.warn(`[Beatport loader] ${message}${suffix}`, error || '');
            if (manual) notify(`${message}${suffix}`);
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url: manual ? `${SHARED_SCRIPT_URL}?tm_refresh=${Date.now()}` : SHARED_SCRIPT_URL,
            headers,
            timeout: REQUEST_TIMEOUT,
            onload(response) {
                updateInFlight = false;

                if (response.status === 304 && previousSource) {
                    if (manual) notify(`The shared core is current (${sharedCoreVersion(previousSource)}).`);
                    return;
                }
                if (response.status !== 200) {
                    fail(`GitHub returned HTTP ${response.status}.`);
                    return;
                }

                const nextSource = response.responseText;
                if (!isValidSharedCore(nextSource)) {
                    fail('GitHub returned an invalid shared core; it was not saved.');
                    return;
                }

                const version = sharedCoreVersion(nextSource);
                if (sourceSignature(nextSource) === GM_getValue(STORAGE.rejectedSignature, '')) {
                    fail(`Shared core ${version} failed to start previously and was not saved again.`);
                    return;
                }

                const changed = nextSource !== previousSource;
                let executedNow = false;
                if (executeIfEmpty && !activeSource && !previousSource) {
                    if (!executeSharedCore(nextSource, 'downloaded shared core')) {
                        fail(`Shared core ${version} could not start and was not saved.`);
                        return;
                    }
                    executedNow = true;
                }

                cacheSharedCore(nextSource, previousSource, response);

                if (manual) {
                    notify(executedNow
                        ? `Shared core ${version} was saved and started.`
                        : changed
                        ? `Shared core ${version} was saved. Reload the page to use it.`
                        : `The shared core is current (${version}).`);
                } else if (changed && previousSource) {
                    console.info(`[Beatport loader] Shared core ${version} cached for the next page load.`);
                }
            },
            onerror(error) {
                fail('The shared core update check failed.', error);
            },
            ontimeout() {
                fail('The shared core update check timed out.');
            },
        });
    }

    GM_registerMenuCommand('Check for shared-core updates now', () => {
        const { primary, fallback } = readCachedSources();
        checkForSharedCoreUpdate({ manual: true, executeIfEmpty: !activeSource && !primary && !fallback });
    });

    GM_registerMenuCommand('Show shared-core status', () => {
        const { primary, fallback } = readCachedSources();
        const lastAttempt = Number(GM_getValue(STORAGE.lastAttempt, 0)) || 0;
        const details = [
            `Active: ${activeSource ? sharedCoreVersion(activeSource) : 'none'}`,
            `Cached: ${primary ? sharedCoreVersion(primary) : 'none'}`,
            `Rollback: ${fallback ? sharedCoreVersion(fallback) : 'none'}`,
            `Confirm artist/label jobs: ${globalThis.BEATPORTDL_CONFIG.confirmLargeJobs ? 'yes' : 'no'}`,
            `Local-only downloads: ${globalThis.BEATPORTDL_CONFIG.localOnly ? 'yes' : 'no'}`,
            `Last update check: ${lastAttempt ? new Date(lastAttempt).toLocaleString() : 'never'}`,
        ];
        notify(details.join('\n'));
    });

    GM_registerMenuCommand('Toggle artist/label confirmation', () => {
        const next = !globalThis.BEATPORTDL_CONFIG.confirmLargeJobs;
        GM_setValue(STORAGE.confirmLargeJobs, next);
        notify(`Artist/label confirmation is now ${next ? 'enabled' : 'disabled'}.`);
    });

    GM_registerMenuCommand('Toggle local-only downloads', () => {
        const next = !globalThis.BEATPORTDL_CONFIG.localOnly;
        globalThis.BEATPORTDL_CONFIG.setLocalOnly(next);
        notify(next
            ? 'Local-only downloads are enabled. New jobs will be converted and left in the local-only Downloads folder.'
            : 'Local-only downloads are disabled. New jobs will use the normal library workflow.');
    });

    startCachedCore();

    const lastAttempt = Number(GM_getValue(STORAGE.lastAttempt, 0)) || 0;
    const retryInterval = activeSource ? UPDATE_INTERVAL : EMPTY_CACHE_RETRY_INTERVAL;
    if (Date.now() - lastAttempt >= retryInterval) {
        checkForSharedCoreUpdate({ executeIfEmpty: !activeSource });
    }
})();
