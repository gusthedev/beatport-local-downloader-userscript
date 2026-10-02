// ==UserScript==
// @name         Beatport Local FLAC Download (Hazel)
// @namespace    local.beatportdl.hazel
// @version      2.0.7
// @description  Adds local BeatportDL buttons for tracks, releases, playlists, charts, labels, and artists.
// @author       Gustavo
// @match        https://www.beatport.com/*
// @match        https://beatport.com/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const INSTANCE_KEY = Symbol.for('tm.beatportdl.local.instance');
    const CORE_VERSION = '2.0.7';
    const TEST_CONFIG = globalThis.__TM_BEATPORTDL_TEST_MODE__;
    const loaderConfig = typeof globalThis.BEATPORTDL_CONFIG === 'object' && globalThis.BEATPORTDL_CONFIG
        ? globalThis.BEATPORTDL_CONFIG
        : {};
    const existingInstance = globalThis[INSTANCE_KEY];

    if (existingInstance) {
        if (TEST_CONFIG) globalThis.__TM_BEATPORTDL_TEST_HOOKS__ = existingInstance.testHooks;
        return;
    }

    function installSafariPlaybackFix(page) {
        const agent = page.navigator?.userAgent || '';
        const safariVersion = agent.match(/Version\/(\d+).*Safari\//);
        if (!safariVersion || Number(safariVersion[1]) !== 27
            || /Chrome|Chromium|CriOS|Edg|OPR|FxiOS/.test(agent)
            || !page.MediaSource || page.__beatportSafariPlaybackFix) return;

        const state = { version: '1.0.1', applied: false };
        const seen = new WeakSet();
        function configure(player) {
            if (!player || typeof player !== 'object' || seen.has(player)) return;
            const adapter = player._audioAdapters?.HlsAdapter;
            const Hls = adapter?._hls?.constructor;
            if (!Hls?.DefaultConfig || !('preferManagedMediaSource' in Hls.DefaultConfig)) return;
            // Safari 27 can leave an out-of-buffer seek pending indefinitely
            // with ManagedMediaSource. Standard MediaSource passes the same seek.
            // Change only Beatport's HLS preference, not browser security settings.
            Hls.DefaultConfig.preferManagedMediaSource = false;
            // BPPlayer is published after its first adapters are constructed.
            // Replace only the unused HLS adapter; never interrupt an active track.
            if (typeof player.getTrack === 'function' && !player.getTrack()
                && adapter._hls.config?.preferManagedMediaSource !== false
                && typeof adapter.destroy === 'function' && typeof adapter.constructor === 'function') {
                const replacement = new adapter.constructor(player._mediaElement, player._audioContext, player._onError);
                adapter.destroy();
                player._audioAdapters.HlsAdapter = replacement;
            }
            seen.add(player);
            state.applied = true;
            console.info('[Beatport loader] Safari 27: standard media buffering enabled.');
        }
        function safelyConfigure(player) {
            try { configure(player); }
            catch (error) { console.warn('[Beatport loader] Safari playback configuration failed:', error); }
        }
        const descriptor = Object.getOwnPropertyDescriptor(page, 'BPPlayer');
        if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) {
            safelyConfigure(page.BPPlayer);
        } else {
            let player = descriptor?.value;
            Object.defineProperty(page, 'BPPlayer', {
                configurable: true,
                enumerable: descriptor?.enumerable ?? true,
                get() { return player; },
                set(value) { player = value; safelyConfigure(value); },
            });
            safelyConfigure(player);
        }
        page.__beatportSafariPlaybackFix = state;
    }

    try { installSafariPlaybackFix(typeof unsafeWindow === 'object' ? unsafeWindow : window); }
    catch (error) { console.warn('[Beatport loader] Safari playback compatibility unavailable:', error); }

    const ICON_CLASS = 'tm-beatportdl-local-icon';
    const TITLE_ICON_CLASS = 'tm-beatportdl-page-title-icon';
    const TITLE_WRAP_CLASS = 'tm-beatportdl-page-title-wrap';
    const LABEL_PARENT_CLASS = 'tm-beatportdl-label-parent';
    const STATUS_ID = 'tm-beatportdl-status';
    const OWNED_ATTRIBUTE = 'data-tm-beatportdl-owned';
    const SUBMISSION_PREFIX = 'beatport.submitted.v1.';
    const SUBMISSION_DAYS = 90;
    const SUBMISSION_TTL = SUBMISSION_DAYS * 24 * 60 * 60 * 1000;
    const SUBMISSION_CLEANUP_KEY = 'beatport.submissionCleanup.v1';
    const SUBMISSION_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
    let lastSubmissionCleanup = 0;
    const MODE_ID = 'tm-beatportdl-mode';
    const submissionMemory = new Map();
    const watchedSubmissions = new Map();
    let titleDirty = true;
    const JOB_DEBOUNCE_MS = 1500;
    const FEEDBACK_MS = 2500;
    const OBJECT_URL_LIFETIME_MS = 10000;
    const supportedPageTypes = new Set(['track', 'release', 'playlist', 'chart', 'label', 'artist']);
    const instance = {
        activeHeading: null,
        activeTitleIcon: null,
        activeTitleParent: null,
        confirmedLargeJobs: new Set(),
        feedbackTimers: new WeakMap(),
        objectUrlTimers: new Map(),
        recentJobs: new Map(),
        resizeObserver: null,
        statusTimer: 0,
        started: false,
        testHooks: null,
        titlePositionFrame: 0,
    };

    const requestFrame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame.bind(globalThis)
        : (callback) => window.setTimeout(callback, 16);
    const cancelFrame = typeof cancelAnimationFrame === 'function'
        ? cancelAnimationFrame.bind(globalThis)
        : window.clearTimeout.bind(window);

    function mediaKey(media) {
        return media ? `${media.type}:${media.id}` : '';
    }

    function isElementNode(value) {
        return Boolean(value) && value.nodeType === 1
            && typeof value.querySelectorAll === 'function';
    }

    function isAnchorNode(value) {
        return isElementNode(value) && String(value.tagName || '').toUpperCase() === 'A';
    }

    function getBeatportMediaUrl(value) {
        try {
            if (typeof value !== 'string' || !value.trim() || /^[#?]/.test(value.trim())) return null;

            const url = new URL(value.trim(), location.href);
            const hostname = url.hostname.toLowerCase();
            const publicMatch = url.pathname.match(/^\/(track|release|playlist|chart|label|artist)\/[^/]+\/(\d+)\/?$/);
            const libraryPlaylistMatch = url.pathname.match(/^\/library\/playlists\/(\d+)\/?$/);

            if ((hostname !== 'beatport.com' && hostname !== 'www.beatport.com') ||
                (!publicMatch && !libraryPlaylistMatch)) {
                return null;
            }

            const type = libraryPlaylistMatch ? 'playlist' : publicMatch[1];
            const id = libraryPlaylistMatch ? libraryPlaylistMatch[1] : publicMatch[2];

            url.protocol = 'https:';
            url.username = '';
            url.password = '';
            url.hostname = 'www.beatport.com';
            url.port = '';
            url.search = '';
            url.hash = '';
            return {
                url: url.href,
                type,
                id,
                libraryPlaylist: Boolean(libraryPlaylistMatch),
            };
        } catch {
            return null;
        }
    }

    function getEligibleMedia(link) {
        if (!isAnchorNode(link)) return null;
        if (!link.closest('main') && !link.closest('[class*="Player-style__"]')) return null;
        return getBeatportMediaUrl(link.getAttribute('href'));
    }

    function isOwnedNode(node) {
        const element = isElementNode(node) ? node : node?.parentElement;
        return Boolean(element?.matches?.(`[${OWNED_ATTRIBUTE}]`) || element?.closest?.(`[${OWNED_ATTRIBUTE}]`));
    }

    function elementsMatching(root, selector) {
        if (!root) return [];
        const matches = isElementNode(root) && root.matches(selector) ? [root] : [];
        if (root.querySelectorAll) matches.push(...root.querySelectorAll(selector));
        return matches;
    }

    function pruneRoots(values) {
        const roots = Array.from(new Set(values)).filter((root) => root && root.isConnected !== false);
        return roots.filter((root, index) => !roots.some((candidate, candidateIndex) => (
            candidateIndex !== index && candidate !== root && candidate.contains?.(root)
        )));
    }

    function createFrameBatcher(flush, scheduleFrame = requestFrame) {
        const roots = new Set();
        let frame = 0;

        const run = () => {
            frame = 0;
            const nextRoots = pruneRoots(roots);
            roots.clear();
            flush(nextRoots);
        };

        return {
            schedule(root) {
                if (root) roots.add(root);
                if (!frame) frame = scheduleFrame(run);
            },
            flushNow() {
                if (frame) cancelFrame(frame);
                run();
            },
            pendingCount() {
                return roots.size;
            },
        };
    }

    function submissionKey(media) { return SUBMISSION_PREFIX + mediaKey(media); }

    function submissionTime(media, now = Date.now()) {
        if (!media) return 0;
        const key = submissionKey(media);
        const raw = typeof GM_getValue === 'function' ? GM_getValue(key, 0) : submissionMemory.get(key);
        const value = Number(raw) || 0;
        return value > 0 && now - value >= 0 && now - value < SUBMISSION_TTL ? value : 0;
    }

    function refreshSubmissionIcon(icon) {
        const media = icon._tmBeatportMedia;
        if (!media) return;
        const when = submissionTime(media);
        icon.classList.toggle('tm-beatportdl-local-submitted', Boolean(when));
        if (!instance.feedbackTimers.has(icon)) {
            icon.disabled = false;
            icon.textContent = when ? '✓' : '⇩';
        }
        const action = when ? `Submitted ${new Date(when).toLocaleString()}; click to submit again`
            : 'Request a local FLAC download';
        icon.title = `${action} (Shift-click copies the URL)`;
        icon.setAttribute('aria-label', `${action}: ${media.type} ${media.id}`);
    }

    function refreshSubmissionIcons() {
        document.querySelectorAll?.(`.${ICON_CLASS}`).forEach(refreshSubmissionIcon);
    }

    function watchSubmission(media) {
        const key = submissionKey(media);
        if (watchedSubmissions.has(key) || typeof GM_addValueChangeListener !== 'function'
            || typeof GM_removeValueChangeListener !== 'function') return;
        watchedSubmissions.set(key, GM_addValueChangeListener(key, refreshSubmissionIcons));
    }

    function pruneSubmissionListeners() {
        const visible = new Set();
        document.querySelectorAll(`.${ICON_CLASS}`).forEach(icon => {
            if (icon._tmBeatportMedia) visible.add(submissionKey(icon._tmBeatportMedia));
        });
        for (const [key, listener] of watchedSubmissions) {
            if (!visible.has(key)) {
                GM_removeValueChangeListener(listener);
                watchedSubmissions.delete(key);
            }
        }
        for (const [key, when] of submissionMemory) {
            if (Date.now() - when >= SUBMISSION_TTL || !visible.has(key)) submissionMemory.delete(key);
        }
    }

    function recordSubmission(media, now = Date.now()) {
        const key = submissionKey(media);
        if (typeof GM_setValue !== 'function') submissionMemory.set(key, now);
        if (typeof GM_setValue === 'function') GM_setValue(key, now);
        refreshSubmissionIcons();
    }

    function pruneSubmissionStorage(now = Date.now()) {
        if (typeof GM_listValues !== 'function' || typeof GM_deleteValue !== 'function'
            || typeof GM_getValue !== 'function') return;
        const last = Number(GM_getValue(SUBMISSION_CLEANUP_KEY, lastSubmissionCleanup)) || 0;
        if (last > 0 && now >= last && now - last < SUBMISSION_CLEANUP_INTERVAL) return;
        for (const key of GM_listValues()) {
            if (!key.startsWith(SUBMISSION_PREFIX)) continue;
            const when = Number(GM_getValue(key, 0));
            if (!when || now - when >= SUBMISSION_TTL || when > now) GM_deleteValue(key);
        }
        // Share the cleanup timestamp across tabs; visible markers still check
        // their own exact expiry without enumerating all stored entries.
        lastSubmissionCleanup = now;
        if (typeof GM_setValue === 'function') GM_setValue(SUBMISSION_CLEANUP_KEY, now);
    }

    function reconcileModeControl() {
        if (loaderConfig.helperEnabled) return;
        let button = document.getElementById(MODE_ID);
        if (typeof loaderConfig.setLocalOnly !== 'function') return;
        if (!button) {
            button = document.createElement('button');
            button.id = MODE_ID;
            button.type = 'button';
            button.setAttribute(OWNED_ATTRIBUTE, 'mode');
            button.addEventListener('click', () => loaderConfig.setLocalOnly(!loaderConfig.localOnly));
            document.documentElement.appendChild(button);
        }
        const localOnly = loaderConfig.localOnly === true;
        button.textContent = localOnly ? 'Downloads: Local only' : 'Downloads: Normal library';
        button.setAttribute('aria-pressed', String(localOnly));
        button.title = 'Switch the destination for new download jobs';
    }

    function clearFeedback(icon, reset = false) {
        const timer = instance.feedbackTimers.get(icon);
        if (timer) window.clearTimeout(timer);
        instance.feedbackTimers.delete(icon);
        if (reset) {
            icon.disabled = false;
            icon.textContent = '⇩';
            icon.classList.remove('tm-beatportdl-local-queued', 'tm-beatportdl-local-error');
            refreshSubmissionIcon(icon);
        }
    }

    function setFeedback(icon, success) {
        clearFeedback(icon);
        icon.disabled = true;
        icon.textContent = success ? '✓' : '!';
        icon.classList.toggle('tm-beatportdl-local-queued', success);
        icon.classList.toggle('tm-beatportdl-local-error', !success);
        const timer = window.setTimeout(() => clearFeedback(icon, true), FEEDBACK_MS);
        instance.feedbackTimers.set(icon, timer);
    }

    function showStatus(message, success = true) {
        let status = document.getElementById?.(STATUS_ID);
        if (!status) {
            status = document.createElement('div');
            status.id = STATUS_ID;
            status.setAttribute(OWNED_ATTRIBUTE, 'status');
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            document.documentElement.appendChild(status);
        }
        if (instance.statusTimer) window.clearTimeout(instance.statusTimer);
        status.classList.toggle('tm-beatportdl-status-error', !success);
        status.textContent = message;
        status.hidden = false;
        instance.statusTimer = window.setTimeout(() => {
            status.hidden = true;
            instance.statusTimer = 0;
        }, FEEDBACK_MS * 2);
    }

    function confirmLargeJob(media) {
        if (!['artist', 'label'].includes(media?.type) || loaderConfig.confirmLargeJobs === false) return true;
        const key = mediaKey(media);
        if (instance.confirmedLargeJobs.has(key)) return true;
        const accepted = typeof window.confirm !== 'function' || window.confirm(
            `Queue this entire ${media.type} catalog? This can create a large BeatportDL job.`
        );
        if (accepted) instance.confirmedLargeJobs.add(key);
        return accepted;
    }

    function copyMediaUrl(media, icon) {
        if (!media?.url) return false;
        try {
            if (typeof GM_setClipboard === 'function') GM_setClipboard(media.url, 'text');
            else if (navigator.clipboard?.writeText) navigator.clipboard.writeText(media.url);
            else return false;
            setFeedback(icon, true);
            showStatus(`Copied ${media.type} URL`);
            return true;
        } catch {
            setFeedback(icon, false);
            showStatus('Could not copy the Beatport URL', false);
            return false;
        }
    }

    function handleMediaAction(event, media, icon) {
        if (event?.shiftKey) return copyMediaUrl(media, icon);
        if (submissionTime(media) && !window.confirm(`This item was submitted in the last ${SUBMISSION_DAYS} days. Submit again?`)) return false;
        if (!confirmLargeJob(media)) return false;
        return createHazelJob(media, icon);
    }

    function updateLabelParent(parent) {
        if (!parent?.classList) return;
        const hasLabelIcon = Array.from(parent.children || []).some((child) => (
            child.classList?.contains(ICON_CLASS) && child.classList.contains('tm-beatportdl-label-icon')
        ));
        parent.classList.toggle(LABEL_PARENT_CLASS, hasLabelIcon);
    }

    function removeIcon(icon) {
        if (!icon) return;
        const parent = icon.parentElement;
        clearFeedback(icon);
        icon.remove();
        updateLabelParent(parent);
        if (icon === instance.activeTitleIcon) {
            instance.activeTitleIcon = null;
            instance.activeHeading = null;
        }
    }

    function claimCurrentIcon(icon) {
        if (!icon || icon.dataset?.tmBeatportCoreVersion === CORE_VERSION) return icon;
        // A different userscript sandbox may have created this DOM node. Reusing
        // it would also reuse that older core's click listener, so replace it.
        removeIcon(icon);
        return null;
    }

    function buildHazelJob(media, date = new Date(), localOnly = loaderConfig.localOnly === true) {
        const timestamp = date.toISOString().replace(/[^0-9]/g, '').slice(0, 17);
        const prefix = localOnly ? 'beatportdl-localonly' : 'beatportdl';
        return {
            contents: `${media.url}\n`,
            filename: `${prefix}-${media.type}-${media.id}-${timestamp}.txt`,
        };
    }

    function claimJob(media, now = Date.now()) {
        const key = mediaKey(media);
        const lastQueued = instance.recentJobs.get(key);
        if (!key || (lastQueued !== undefined && now - lastQueued < JOB_DEBOUNCE_MS)) return false;
        instance.recentJobs.set(key, now);
        for (const [oldKey, queuedAt] of instance.recentJobs) {
            if (now - queuedAt > JOB_DEBOUNCE_MS * 4) instance.recentJobs.delete(oldKey);
        }
        return true;
    }

    function revokeObjectUrl(objectUrl) {
        const timer = instance.objectUrlTimers.get(objectUrl);
        if (timer) window.clearTimeout(timer);
        instance.objectUrlTimers.delete(objectUrl);
        try {
            URL.revokeObjectURL(objectUrl);
        } catch {
            // The page may already be unloading.
        }
    }

    function scheduleObjectUrlCleanup(objectUrl) {
        const timer = window.setTimeout(() => revokeObjectUrl(objectUrl), OBJECT_URL_LIFETIME_MS);
        instance.objectUrlTimers.set(objectUrl, timer);
    }

    function cleanupObjectUrls() {
        for (const objectUrl of Array.from(instance.objectUrlTimers.keys())) revokeObjectUrl(objectUrl);
    }

    function createHazelJob(media, icon) {
        if (!media?.url || !icon || icon.disabled || !claimJob(media)) return false;
        if (loaderConfig.helperEnabled) {
            icon.disabled = true;
            const mode = loaderConfig.localOnly ? 'local' : 'library';
            ensureQueuePanel();
            queueMessage('Sending request…');
            const ready = !queueLastSnapshot && loaderConfig.getHelperToken?.() ? wakeQueue() : Promise.resolve();
            ready.then(() => queueAPI('/jobs', { urls: [media.url], mode })).then(() => {
                recordSubmission(media);
                setFeedback(icon, true);
                queueMessage('Queued');
                pollQueue();
            }).catch(error => {
                instance.recentJobs.delete(mediaKey(media));
                setFeedback(icon, false);
                queueMessage(error.message, true);
            });
            return true;
        }

        let download = null;
        let objectUrl = '';
        try {
            const job = buildHazelJob(media);
            const blob = new Blob([job.contents], { type: 'text/plain;charset=utf-8' });
            objectUrl = URL.createObjectURL(blob);
            download = document.createElement('a');
            download.setAttribute(OWNED_ATTRIBUTE, 'download');
            download.href = objectUrl;
            download.download = job.filename;
            download.style.display = 'none';
            document.documentElement.appendChild(download);
            download.click();
            scheduleObjectUrlCleanup(objectUrl);
            recordSubmission(media);
            setFeedback(icon, true);
            showStatus(loaderConfig.localOnly === true
                ? `Local-only ${media.type} job file requested`
                : `Job file requested: ${job.filename}`);
            return true;
        } catch {
            if (objectUrl) revokeObjectUrl(objectUrl);
            setFeedback(icon, false);
            showStatus('Could not create the Hazel job', false);
            return false;
        } finally {
            download?.remove();
        }
    }

    function adjacentLinkIcons(link) {
        const icons = [];
        let sibling = link.nextElementSibling;
        while (sibling?.classList?.contains(ICON_CLASS) && !sibling.classList.contains(TITLE_ICON_CLASS)) {
            icons.push(sibling);
            sibling = sibling.nextElementSibling;
        }
        return icons;
    }

    function semanticItem(link) {
        return link.closest(
            'tr, li, article, [role="row"], [data-testid*="track" i], '
            + '[class*="TrackRow"], [class*="TableRow"], [class*="ListItem"]'
        );
    }

    function preferredMediaLink(link, media, rowCache = new Map()) {
        const item = semanticItem(link);
        if (!item) return link;
        if (!rowCache.has(item)) {
            const bestByMedia = new Map();
            for (const candidate of item.querySelectorAll('a[href]')) {
                const candidateMedia = getEligibleMedia(candidate);
                const text = candidate.textContent.trim();
                if (!candidateMedia || !text || candidate.querySelector('img, picture')) continue;
                const key = mediaKey(candidateMedia);
                const score = Math.min(text.length, 80) + (candidate.querySelector('h1, h2, h3, h4') ? 200 : 0);
                if (!bestByMedia.has(key) || score > bestByMedia.get(key).score) {
                    bestByMedia.set(key, { link: candidate, score });
                }
            }
            rowCache.set(item, bestByMedia);
        }
        return rowCache.get(item).get(mediaKey(media))?.link || link;
    }

    function enhanceLink(link, rowCache) {
        if (!isAnchorNode(link) || link.classList.contains(ICON_CLASS)) return;

        const media = getEligibleMedia(link);
        const icons = adjacentLinkIcons(link);
        const existingIcon = claimCurrentIcon(icons.shift() || null);
        icons.forEach(removeIcon);
        const containsArtwork = Boolean(link.querySelector('img, picture'));

        if (!media || !link.textContent.trim() || containsArtwork || preferredMediaLink(link, media, rowCache) !== link) {
            removeIcon(existingIcon);
            return;
        }

        const label = link.textContent.trim();
        const icon = existingIcon || document.createElement('button');
        if (!existingIcon) {
            icon.className = ICON_CLASS;
            icon.setAttribute(OWNED_ATTRIBUTE, 'link');
            icon.type = 'button';
            icon.textContent = '⇩';
            icon.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                handleMediaAction(event, icon._tmBeatportMedia, icon);
            });
            link.insertAdjacentElement('afterend', icon);
        }

        icon.classList.toggle('tm-beatportdl-label-icon', media.type === 'label');
        icon.dataset.tmBeatportCoreVersion = CORE_VERSION;
        icon.dataset.tmBeatportMediaKey = mediaKey(media);
        icon._tmBeatportMedia = media;
        icon.title = 'Queue a local FLAC download with BeatportDL (Shift-click copies the URL)';
        icon.setAttribute('aria-label', `Queue ${label} for local FLAC download; Shift-click copies its URL`);
        updateLabelParent(icon.parentElement);
        watchSubmission(media);
        refreshSubmissionIcon(icon);
    }

    function reconcileLinkIcons(root) {
        for (const icon of elementsMatching(root, `.${ICON_CLASS}:not(.${TITLE_ICON_CLASS})`)) {
            const link = icon.previousElementSibling;
            if (!isAnchorNode(link) || adjacentLinkIcons(link)[0] !== icon) {
                removeIcon(icon);
                continue;
            }
            const media = getEligibleMedia(link);
            if (!media || !link.textContent.trim() || link.querySelector('img, picture')) removeIcon(icon);
            else if (icon.dataset.tmBeatportMediaKey !== mediaKey(media)) enhanceLink(link);
        }
    }

    function enhanceBeatportLinks(root = document, rowCache = new Map()) {
        if (isAnchorNode(root)) enhanceLink(root, rowCache);
        if (root.querySelectorAll) root.querySelectorAll('a[href]').forEach(link => enhanceLink(link, rowCache));
        reconcileLinkIcons(root);
    }

    function isVisibleHeading(heading) {
        if (!heading?.isConnected || heading.hidden || heading.closest('[hidden], [aria-hidden="true"]')) return false;
        if (typeof getComputedStyle === 'function') {
            const style = getComputedStyle(heading);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return Boolean(heading.textContent.trim());
    }

    function findPageHeading(media) {
        if (!supportedPageTypes.has(media?.type)) return null;
        const preferredSelector = media.type === 'release'
            ? 'main h1[class*="ReleaseDetailCard-style__Name"]'
            : media.type === 'track'
                ? 'main h1[class*="TrackDetail"]'
                : `main h1[class*="${media.type[0].toUpperCase()}${media.type.slice(1)}"]`;
        const headings = [
            ...document.querySelectorAll(preferredSelector),
            ...document.querySelectorAll('main h1'),
        ];
        return Array.from(new Set(headings)).find(isVisibleHeading) || null;
    }

    function itemDescription(media) {
        const descriptions = {
            artist: 'artist catalog',
            chart: 'chart',
            label: 'label catalog',
            playlist: 'playlist',
            release: 'full release',
            track: 'track',
        };
        return descriptions[media.type] || media.type;
    }

    function disconnectTitleResizeObserver() {
        instance.resizeObserver?.disconnect();
        instance.resizeObserver = null;
    }

    function removePageActions(except = null) {
        for (const icon of document.querySelectorAll(`.${TITLE_ICON_CLASS}`)) {
            if (icon !== except) removeIcon(icon);
        }
        if (instance.activeTitleParent && instance.activeTitleParent !== except?.parentElement) {
            instance.activeTitleParent.classList.remove(TITLE_WRAP_CLASS);
        }
        for (const parent of document.querySelectorAll(`.${TITLE_WRAP_CLASS}`)) {
            if (parent !== except?.parentElement) parent.classList.remove(TITLE_WRAP_CLASS);
        }
        if (!except) {
            instance.activeHeading = null;
            instance.activeTitleIcon = null;
            instance.activeTitleParent = null;
            disconnectTitleResizeObserver();
        }
    }

    function positionPageTitleIcon() {
        instance.titlePositionFrame = 0;
        const heading = instance.activeHeading;
        const icon = instance.activeTitleIcon;
        const parent = instance.activeTitleParent;
        if (!heading?.isConnected || !icon?.isConnected || !parent?.isConnected) return;

        const range = document.createRange();
        range.selectNodeContents(heading);
        const textRects = Array.from(range.getClientRects()).filter((rect) => rect.width && rect.height);
        const textRect = textRects[textRects.length - 1] || heading.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        const iconSize = 16;
        const gap = 10;
        const maximumLeft = Math.max(0, parentRect.width - iconSize);
        const left = Math.min(maximumLeft, Math.max(0, textRect.right - parentRect.left + gap));
        const top = Math.max(0, textRect.top - parentRect.top + ((textRect.height - iconSize) / 2));

        icon.style.setProperty('--tm-beatportdl-title-left', `${left}px`);
        icon.style.setProperty('--tm-beatportdl-title-top', `${top}px`);
        range.detach?.();
    }

    function scheduleTitlePosition() {
        if (!instance.titlePositionFrame) instance.titlePositionFrame = requestFrame(positionPageTitleIcon);
    }

    function observeTitleSize(heading, parent) {
        disconnectTitleResizeObserver();
        if (typeof ResizeObserver !== 'function') return;
        instance.resizeObserver = new ResizeObserver(scheduleTitlePosition);
        instance.resizeObserver.observe(heading);
        if (parent !== heading) instance.resizeObserver.observe(parent);
    }

    function reconcilePageAction() {
        const media = getBeatportMediaUrl(location.href);
        const heading = findPageHeading(media);
        const parent = heading?.parentElement;

        if (!media || !supportedPageTypes.has(media.type) || !heading || !parent) {
            removePageActions();
            return;
        }

        const candidates = Array.from(document.querySelectorAll(`.${TITLE_ICON_CLASS}`));
        let icon = claimCurrentIcon(
            candidates.find((candidate) => candidate.previousElementSibling === heading) || null
        );
        if (!icon) {
            icon = document.createElement('button');
            icon.className = `${ICON_CLASS} ${TITLE_ICON_CLASS}`;
            icon.setAttribute(OWNED_ATTRIBUTE, 'page');
            icon.type = 'button';
            icon.textContent = '⇩';
            icon.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                handleMediaAction(event, icon._tmBeatportMedia, icon);
            });
            heading.insertAdjacentElement('afterend', icon);
        }

        removePageActions(icon);
        const titleChanged = instance.activeHeading !== heading || instance.activeTitleParent !== parent;
        instance.activeHeading = heading;
        instance.activeTitleIcon = icon;
        instance.activeTitleParent = parent;
        parent.classList.add(TITLE_WRAP_CLASS);
        icon.dataset.tmBeatportCoreVersion = CORE_VERSION;
        icon.dataset.tmBeatportMediaKey = mediaKey(media);
        icon._tmBeatportMedia = media;
        const description = itemDescription(media);
        icon.title = `Queue this ${description} for local FLAC download with BeatportDL`;
        icon.setAttribute('aria-label', `Queue the ${description} ${heading.textContent.trim()} for local FLAC download`);
        if (titleChanged || !instance.resizeObserver) observeTitleSize(heading, parent);
        watchSubmission(media);
        refreshSubmissionIcon(icon);
        scheduleTitlePosition();
    }

    function flushRoots(roots) {
        const rowCache = new Map();
        for (const root of roots) enhanceBeatportLinks(root, rowCache);
        if (titleDirty || (instance.activeHeading && (!instance.activeHeading.isConnected || !instance.activeTitleIcon?.isConnected))) {
            titleDirty = false;
            reconcilePageAction();
        }
        pruneSubmissionListeners();
    }

    const batcher = createFrameBatcher(flushRoots);

    function mutationRoot(node) {
        if (isElementNode(node) || node === document) return node;
        return node?.parentElement || null;
    }

    function titleMutation(mutation) {
        const target = mutationRoot(mutation.target);
        if (isOwnedNode(target)) return false;
        if (instance.activeHeading?.contains?.(target) || target?.matches?.('main h1')) return true;
        return [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])].some(node =>
            !isOwnedNode(node) && isElementNode(node)
            && (node.matches?.('h1, main') || node.querySelector?.('h1')));
    }

    function handleMutations(mutations) {
        for (const mutation of mutations) {
            if (titleMutation(mutation)) titleDirty = true;
            if (mutation.type === 'attributes') {
                if (!isOwnedNode(mutation.target)) batcher.schedule(mutationRoot(mutation.target));
                continue;
            }
            if (mutation.type === 'characterData') {
                if (!isOwnedNode(mutation.target)) batcher.schedule(mutationRoot(mutation.target));
                continue;
            }

            let hasRelevantRemoval = false;
            for (const node of mutation.removedNodes) {
                if (!isOwnedNode(node)) hasRelevantRemoval = true;
            }
            if (hasRelevantRemoval) batcher.schedule(mutationRoot(mutation.target));
            let hasRelevantAddition = false;
            for (const node of mutation.addedNodes) {
                if (!isOwnedNode(node)) {
                    hasRelevantAddition = true;
                    batcher.schedule(mutationRoot(node) || mutationRoot(mutation.target));
                }
            }
            // Reconcile the changed parent too. For example, artwork inserted into an
            // already-enhanced link makes that link ineligible even though the new image
            // subtree contains no anchor of its own.
            if (hasRelevantAddition) batcher.schedule(mutationRoot(mutation.target));
        }
    }

    function wrapHistoryMethod(historyObject, name, onNavigate) {
        const original = historyObject?.[name];
        if (typeof original !== 'function') return null;
        const wrapped = function (...args) {
            const before = location.href;
            const result = Reflect.apply(original, this, args);
            if (location.href !== before) onNavigate();
            return result;
        };
        historyObject[name] = wrapped;
        return original;
    }

    function installNavigationHooks() {
        const onNavigate = () => {
            removePageActions();
            titleDirty = true;
            batcher.schedule();
        };
        try {
            wrapHistoryMethod(history, 'pushState', onNavigate);
            wrapHistoryMethod(history, 'replaceState', onNavigate);
        } catch {
            // Beatport navigation still produces DOM mutations and popstate events.
        }
        window.addEventListener('popstate', onNavigate, { passive: true });
    }

    function addIconStyles() {
        if (document.getElementById('tm-beatportdl-local-styles')) return;
        const style = document.createElement('style');
        style.id = 'tm-beatportdl-local-styles';
        style.setAttribute(OWNED_ATTRIBUTE, 'style');
        style.textContent = `
            .${ICON_CLASS} {
                align-items: center; align-self: center; appearance: none; background: #01ff95;
                border: 0 !important; border-radius: 50%; box-sizing: border-box !important;
                color: #09130f !important; cursor: pointer; display: inline-flex; flex: 0 0 16px !important;
                font: 800 12px/1 system-ui, sans-serif; height: 16px !important; inset: auto !important;
                justify-content: center; margin: 0 0 0 5px !important; max-height: 16px !important;
                max-width: 16px !important; min-height: 16px !important; min-width: 16px !important;
                opacity: 0.72; overflow: hidden; padding: 0 !important; position: static !important;
                transition: opacity 120ms ease, transform 120ms ease; vertical-align: middle;
                white-space: nowrap; width: 16px !important;
            }
            #${MODE_ID} {
                position: fixed; right: 16px; bottom: 110px; z-index: 2147483646;
                padding: 8px 12px; border: 1px solid #01ff95; border-radius: 7px;
                background: #0b2018; color: #fff; font: 600 12px system-ui; cursor: pointer;
            }
            .${ICON_CLASS}.tm-beatportdl-local-submitted { background: #fff; opacity: 1; }
            .${ICON_CLASS}:hover, .${ICON_CLASS}:focus-visible { opacity: 1; transform: scale(1.12); }
            .${ICON_CLASS}:disabled { cursor: wait; }
            .${ICON_CLASS}.tm-beatportdl-local-queued { background: #ffffff; opacity: 1; }
            .${ICON_CLASS}.tm-beatportdl-local-error { background: #ff6b6b; opacity: 1; }
            .${TITLE_WRAP_CLASS} { position: relative !important; }
            .${ICON_CLASS}.${TITLE_ICON_CLASS} {
                align-self: auto; left: var(--tm-beatportdl-title-left) !important; margin: 0 !important;
                position: absolute !important; top: var(--tm-beatportdl-title-top) !important; z-index: 2;
            }
            .${LABEL_PARENT_CLASS} {
                align-items: center !important; display: flex !important; flex-flow: row nowrap !important;
            }
            .${LABEL_PARENT_CLASS} > a { flex: 0 1 auto !important; min-width: 0 !important; width: auto !important; }
            #${STATUS_ID} {
                background: #0b2018; border: 1px solid #01ff95; border-radius: 7px; bottom: 110px;
                color: #fff; font: 600 13px/1.35 system-ui, sans-serif; left: 50%; max-width: min(520px, 88vw);
                padding: 8px 12px; position: fixed; transform: translateX(-50%); z-index: 2147483647;
            }
            #${STATUS_ID}.tm-beatportdl-status-error { border-color: #ff6b6b; }
            #${STATUS_ID}[hidden] { display: none !important; }
        `;
        document.documentElement.appendChild(style);
    }

    const HELPER_URL = 'http://127.0.0.1:17854';
    let queuePanel, queueHost, queuePollTimer = 0, queuePolling = false, queueWaking;
    let queueLastSnapshot = null;
    let queuePageHidden = false;
    let pairingRequestedAt = 0;
    let queueSleepAt = 0, queueSleepTimer = 0;

    function updateHelperCountdown() {
        window.clearTimeout(queueSleepTimer);
        if (!queuePanel) return;
        const label = queuePanel.querySelector('[data-sleep]');
        label.hidden = !queueLastSnapshot || (!queueLastSnapshot.active && !queueSleepAt);
        if (queueLastSnapshot?.active) { label.textContent = 'Helper stays awake while working.'; return; }
        if (!queueSleepAt || !queueLastSnapshot) return;
        const seconds = Math.max(0, Math.ceil((queueSleepAt - performance.now()) / 1000));
        label.textContent = `Helper sleeps in ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
        if (queuePanel.querySelector('[data-panel]').hidden || document.hidden || queuePageHidden) return;
        if (seconds > 0) queueSleepTimer = window.setTimeout(updateHelperCountdown, 1000);
        else {
            label.textContent = 'Helper is going to sleep.';
            if (queueLastSnapshot.idle_remaining > 0) pollQueue();
        }
    }
    const QUEUE_ERROR_SEEN_KEY = 'beatportLoader.queueErrorsSeen.v1';
    const QUEUE_ERROR_START_KEY = 'beatportLoader.queueErrorAlertsSince.v1';
    let queueErrorsSeen = {};
    let queueErrorAlertsSince = Date.now() / 1000;
    try {
        if (typeof GM_getValue === 'function') queueErrorAlertsSince = Number(GM_getValue(QUEUE_ERROR_START_KEY, 0)) || queueErrorAlertsSince;
        if (typeof GM_setValue === 'function') GM_setValue(QUEUE_ERROR_START_KEY, queueErrorAlertsSince);
        const saved = typeof GM_getValue === 'function' ? GM_getValue(QUEUE_ERROR_SEEN_KEY, {}) : {};
        queueErrorsSeen = mergeQueueErrorsSeen(saved);
    } catch {}

    function mergeQueueErrorsSeen(...records) {
        const merged = Object.create(null);
        for (const record of records) {
            if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
            for (const [id, stamp] of Object.entries(record)) {
                if (typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0) {
                    merged[id] = Math.max(merged[id] || 0, stamp);
                }
            }
        }
        // Deterministic pruning also makes simultaneous capped writes converge.
        return Object.fromEntries(Object.entries(merged)
            .sort((a,b) => b[1]-a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0,200));
    }

    function syncQueueErrorsSeen(...records) {
        let saved = {};
        try { if (typeof GM_getValue === 'function') saved = GM_getValue(QUEUE_ERROR_SEEN_KEY, {}); } catch {}
        queueErrorsSeen = mergeQueueErrorsSeen(queueErrorsSeen, saved, ...records);
        const entries = Object.entries(queueErrorsSeen);
        const same = saved && typeof saved === 'object' && !Array.isArray(saved)
            && Object.keys(saved).length === entries.length && entries.every(([id, stamp]) => saved[id] === stamp);
        // Read/merge before writing, then repair overlapping writes via the
        // listener below. GM storage has no atomic read/modify/write operation.
        if (!same) {
            try { if (typeof GM_setValue === 'function') GM_setValue(QUEUE_ERROR_SEEN_KEY, queueErrorsSeen); } catch {}
        }
    }

    function updateQueueAttention() {
        if (!queuePanel || !queueLastSnapshot) return;
        const open = !queuePanel.querySelector('[data-panel]').hidden;
        const historyOpen = queuePanel.querySelector('[data-history]').open;
        const errors = (queueLastSnapshot.jobs || []).filter(job =>
            Number(job.updated) >= queueErrorAlertsSince && (job.state === 'failed' || job.state === 'waiting_venus' && job.error));
        const reviewed = Object.create(null);
        for (const job of errors) {
            const stamp = Number(job.updated) || 1;
            if (open && (job.state !== 'failed' || historyOpen)) {
                reviewed[job.id] = Math.max(reviewed[job.id] || 0, stamp);
            }
        }
        syncQueueErrorsSeen(reviewed);
        // A stale snapshot must not regress a newer acknowledgment. A later
        // failure of the same job still needs review when its timestamp advances.
        const unseen = errors.filter(job => !(queueErrorsSeen[job.id] >= (Number(job.updated) || 1))).length;
        const button = queuePanel.querySelector('[data-toggle]');
        button.classList.toggle('needs-attention', !open && unseen > 0);
        const current = queueLastSnapshot.current_count ?? (queueLastSnapshot.jobs || []).filter(job => ['queued','downloading','processing','waiting_venus'].includes(job.state)).length;
        button.textContent = unseen ? `Downloads · ${unseen} to check` : 'Downloads' + (current ? ' · ' + current : '');
        button.title = unseen ? 'A download needs attention. Open the panel and History to review.' : 'Open download queue';
    }

    function pairingStatus(state) {
        if (!queuePanel) return;
        const labels = { connected:'Connected to local helper', saved:'Pairing saved · helper asleep or unavailable',
            missing:'This browser needs one-time setup', rejected:'Pairing needs repair · pair this browser again' };
        queuePanel.querySelector('[data-pairing-status]').textContent = labels[state];
        queuePanel.querySelector('[data-auto-pair]').hidden = state === 'connected' || state === 'saved';
    }

    function downloadWakeFile(name) {
        const link = document.createElement('a');
        const objectURL = URL.createObjectURL(new Blob(['Wake Beatport Queue\n'], { type:'text/plain' }));
        link.href = objectURL; link.download = name; link.style.display = 'none';
        document.documentElement.appendChild(link); link.click(); link.remove();
        scheduleObjectUrlCleanup(objectURL);
    }

    function requestBrowserPairing() {
        if (Date.now() - pairingRequestedAt < 10000) return;
        const agent = navigator.userAgent || '';
        const browser = /Chrome\//.test(agent) && !/Edg|OPR/.test(agent) ? 'chrome'
            : /Version\/.*Safari\//.test(agent) ? 'safari' : 'default';
        try {
            downloadWakeFile('beatportdl-wake-pair-' + browser + '-' + Date.now() + '.txt');
            pairingRequestedAt = Date.now();
            queueMessage('Opening the private installer through Hazel. Approve Update in Tampermonkey, then reload Beatport. If it says Reinstall or warns about resetting settings, cancel. No code to copy.');
        } catch {
            queueMessage('Could not request setup. Run Install Beatport Loader.command from your local BeatportDL folder.', true);
        }
    }

    function helperRequest(path, data) {
        const token = loaderConfig.getHelperToken?.() || '';
        if (!token) {
            pairingStatus('missing');
            return Promise.reject(new Error('Click Pair this browser for automatic setup.'));
        }
        return new Promise((resolve, reject) => GM_xmlhttpRequest({
            method: data === undefined ? 'GET' : 'POST', url: HELPER_URL + path,
            headers: { Authorization: 'Bearer ' + token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(data === undefined ? {} : { data: JSON.stringify(data) }), timeout: 6000,
            onload(response) {
                try {
                    const value = JSON.parse(response.responseText);
                    if (response.status === 403 && (!value.code || value.code === 'pairing_required')) pairingStatus('rejected');
                    if (response.status >= 400) throw new Error(value.error || 'Local helper refused the request.');
                    pairingStatus('connected');
                    resolve(value);
                } catch (error) { reject(error); }
            },
            onerror() { pairingStatus('saved'); reject(new Error('Helper asleep or unavailable. Use Start / reconnect.')); },
            ontimeout() { pairingStatus('saved'); reject(new Error('Helper did not respond. Accepted jobs stay saved; reconnect to check.')); },
        }));
    }

    function wakeQueue() {
        if (queueWaking) return queueWaking;
        queueWaking = (async () => {
            if (!loaderConfig.getHelperToken?.()) { pairingStatus('missing'); throw new Error('Click Pair this browser for automatic setup.'); }
            try { await helperRequest('/health'); return; } catch (error) {
                if (/pairing|refused/i.test(error.message)) throw error;
            }
            // One transient wake file when asleep, never a per-track job file.
            downloadWakeFile('beatportdl-wake-' + Date.now() + '.txt');
            queueMessage('Starting local helper through Hazel…');
            for (let attempt = 0; attempt < 15; attempt++) {
                await new Promise(resolve => window.setTimeout(resolve, 1000));
                try { await helperRequest('/health'); return; } catch {}
            }
            throw new Error('Hazel did not start the helper. Check its Beatport rule and Downloads folder.');
        })().finally(() => { queueWaking = null; });
        return queueWaking;
    }

    async function queueAPI(path, data) {
        // Never silently fall back to a TXT job: a response may have been lost
        // after acceptance. Database dedup makes an explicit retry safe.
        await wakeQueue();
        return helperRequest(path, data);
    }

    function queueMessage(message, error = false) {
        if (!queuePanel) return;
        queuePanel.querySelector('[data-message]').textContent = message;
        queuePanel.querySelector('[data-toggle]').textContent = error ? 'Downloads !' : message === 'Queued' ? 'Downloads · queued' : 'Downloads';
        queuePanel.querySelector('[data-message]').style.color = error ? '#ffb5a8' : '';
    }

    function setQueueOpen(open) {
        if (!queuePanel) return;
        queuePanel.querySelector('[data-panel]').hidden = !open;
        queuePanel.querySelector('[data-toggle]').setAttribute('aria-expanded', String(open));
        updateQueueAttention();
        updateHelperCountdown();
        if (open) pollQueue();
    }

    function renderQueue(snapshot) {
        queueLastSnapshot = snapshot;
        queueSleepAt = typeof snapshot.idle_remaining === 'number' ? performance.now() + snapshot.idle_remaining * 1000 : 0;
        updateHelperCountdown();
        const jobs = snapshot.jobs || [];
        const current = jobs.filter(job => ['queued', 'downloading', 'processing', 'waiting_venus'].includes(job.state));
        const history = jobs.filter(job => ['completed', 'failed', 'cancelled'].includes(job.state));
        const active = snapshot.current_count ?? current.length;
        // Historical failures belong in history, not a permanent new-error badge.
        queuePanel.querySelector('[data-toggle]').textContent = 'Downloads' + (active ? ' · ' + active : '');
        queuePanel.querySelector('[data-venus]').hidden = !!snapshot.venus;
        const venusButton = queuePanel.querySelector('[data-connect]');
        venusButton.textContent = snapshot.venus ? 'Venus Connected' : 'Venus Disconnected';
        venusButton.disabled = !!snapshot.venus;
        venusButton.style.color = snapshot.venus ? '#a6f3c8' : '';
        venusButton.title = snapshot.venus ? 'Venus is already connected.' : 'Click to connect to Venus.';
        queuePanel.querySelector('[data-pause]').textContent = snapshot.paused ? 'Resume queue' : 'Pause after current job';
        const note = snapshot.venus && snapshot.note === 'Venus connected' ? '' : snapshot.note;
        queuePanel.querySelector('[data-message]').textContent = snapshot.paused ? 'Queue saved and paused.'
            : note || (snapshot.active ? 'Working · safe to close this page.' : 'No active work · helper will exit automatically.');
        queuePanel.querySelector('[data-message]').style.color = '';
        const list = queuePanel.querySelector('[data-jobs]');
        const historyList = queuePanel.querySelector('[data-history-jobs]');
        list.replaceChildren();
        historyList.replaceChildren();
        const count = snapshot.history_count ?? history.length;
        queuePanel.querySelector('[data-history-title]').textContent = 'History' + (count ? ` · latest ${Math.min(10, history.length)} of ${count}` : ' · empty');
        queuePanel.querySelector('[data-clear-completed]').hidden = !(snapshot.completed_history_count ?? history.filter(job => job.state !== 'failed').length);
        queuePanel.querySelector('[data-clear-failed]').hidden = !(snapshot.failed_history_count ?? history.filter(job => job.state === 'failed').length);
        const retryAll = queuePanel.querySelector('[data-retry-failed]');
        retryAll.hidden = !(snapshot.retryable_count > 0);
        retryAll.textContent = `Retry failed jobs (${snapshot.retryable_count || 0})`;
        for (const job of [...current, ...history.slice(0, 10)]) {
            const row = document.createElement('article');
            const title = document.createElement('strong'); title.textContent = job.title;
            const mode = document.createElement('small');
            mode.hidden = job.state === 'completed';
            mode.textContent = job.local_exception ? 'Local exception · no Venus or Music import'
                : job.mode === 'local' ? 'Local only' : 'Venus library';
            const state = document.createElement('div');
            const delivery = job.mode === 'local' || job.local_exception ? 'locally' : 'to Venus';
            const fileCount = `${job.complete}/${job.files} ${job.files === 1 ? 'file' : 'files'} delivered ${delivery}`;
            state.textContent = job.state === 'completed' && job.files > 0 && job.label !== 'Duplicate' ? fileCount : job.label;
            const detail = document.createElement('small');
            detail.textContent = job.error || job.detail || (job.files > 1 && job.state !== 'completed' ? fileCount : '');
            detail.hidden = !detail.textContent;
            row.append(title, mode, state, detail);
            const isHistory = ['completed','failed','cancelled'].includes(job.state);
            if (isHistory && job.updated) {
                const date = document.createElement('small'); date.textContent = new Date(job.updated * 1000).toLocaleString(); row.append(date);
            }
            if (job.state === 'failed' || job.state === 'waiting_venus' && job.error) {
                const retry = document.createElement('button'); retry.textContent = job.state === 'waiting_venus' ? 'Retry transfer' : 'Retry this job';
                retry.addEventListener('click', () => panelAction('/retry', { id: job.id }));
                row.append(retry);
            }
            (isHistory ? historyList : list).append(row);
        }
        if (!current.length) list.textContent = 'No current downloads.';
        else if (active > current.length) {
            const more = document.createElement('small'); more.textContent = `Showing ${current.length} of ${active} current jobs.`; list.append(more);
        }
        if (!history.length) historyList.textContent = 'No visible history.';
        updateQueueAttention();
    }

    function queueHasActiveWork() {
        return queueLastSnapshot && (queueLastSnapshot.active ||
            !queueLastSnapshot.paused && queueLastSnapshot.jobs.some(job => ['queued','downloading','processing'].includes(job.state)));
    }

    function suspendQueuePolling() {
        window.clearTimeout(queuePollTimer);
        window.clearTimeout(queueSleepTimer);
    }

    function resumeQueuePolling() {
        if (!queuePanel || document.hidden || queuePageHidden) return;
        // A collapsed queue still observes active work for new failures. An
        // idle collapsed queue must not start a permanent polling loop.
        if (!queuePanel.querySelector('[data-panel]').hidden || queueHasActiveWork()) pollQueue();
    }

    async function pollQueue() {
        window.clearTimeout(queuePollTimer);
        if (queuePolling || !queuePanel || document.hidden || queuePageHidden) return;
        queuePolling = true;
        try {
            const snapshot = await helperRequest('/jobs');
            renderQueue(snapshot);
        } catch (error) {
            queueLastSnapshot = null;
            queueSleepAt = 0;
            window.clearTimeout(queueSleepTimer);
            queuePanel.querySelector('[data-sleep]').textContent = 'Helper asleep or unavailable.';
            queueMessage(error.message);
        } finally {
            queuePolling = false;
            if (!document.hidden && !queuePageHidden && queueHasActiveWork()) queuePollTimer = window.setTimeout(pollQueue, 1500);
            else if (queueLastSnapshot?.idle_remaining > 0 && !queuePanel.querySelector('[data-panel]').hidden && !document.hidden && !queuePageHidden) {
                // Read the real deadline periodically: another tab may have
                // extended it. GET never keeps the helper awake.
                queuePollTimer = window.setTimeout(pollQueue, Math.min(10000, queueLastSnapshot.idle_remaining * 1000 + 250));
            }
        }
    }

    async function panelAction(path, data = {}) {
        try { await queueAPI(path, data); await pollQueue(); }
        catch (error) { queueMessage(error.message, true); }
    }

    function ensureQueuePanel() {
        if (queuePanel) return;
        queueHost = document.createElement('div');
        queueHost.id = 'tm-beatportdl-queue';
        queueHost.setAttribute(OWNED_ATTRIBUTE, 'queue');
        // Only the compact tab/panel intercepts clicks; there is no backdrop.
        queueHost.style.cssText = 'position:fixed;top:88px;right:8px;z-index:2147483645;pointer-events:none;';
        queuePanel = queueHost.attachShadow({ mode: 'closed' });
        queuePanel.innerHTML = `
          <style>
            :host { all:initial; }
            * { box-sizing:border-box; } [hidden] { display:none!important; }
            button,input,textarea,select { font:inherit; }
            button,select { color:#f0f7f3;background:#26352e;border:1px solid #526258;border-radius:6px;padding:7px 9px;cursor:pointer; }
            button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible { outline:2px solid #01ff95;outline-offset:2px; }
            [data-toggle] { pointer-events:auto;display:block;margin-left:auto;font:12px system-ui;padding:7px 9px; }
            [data-toggle].needs-attention { background:#8b2424;border-color:#ff8989;color:#fff; }
            section { pointer-events:auto;width:min(350px,calc(100vw - 24px));max-height:max(90px,calc(100dvh - 250px));overflow:auto;
              padding:14px;margin-top:6px;border:1px solid #41534a;border-radius:10px;background:#142019;color:#eff7f2;font:13px/1.4 system-ui;box-shadow:0 6px 20px #0005; }
            header,.actions { display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px; }
            [data-connect]:disabled { cursor:default; }
            header strong { flex:1; } label,small { display:block; } small { color:#b9cbbf;overflow-wrap:anywhere; }
            select,input,textarea { max-width:100%;width:100%;margin:5px 0 9px; }
            input,textarea { background:#0e1712;color:#f0f7f3;border:1px solid #526258;border-radius:4px;padding:7px; }
            article { border-top:1px solid #36493d;padding:10px 0;overflow-wrap:anywhere; } article strong { font-weight:600; }
            [data-message] { margin:8px 0; } details { margin-top:10px; } summary { cursor:pointer; }
            @media(pointer:coarse) { button,select { min-height:44px; } }
          </style>
          <button type="button" data-toggle aria-expanded="false">Downloads</button>
          <section data-panel hidden aria-label="Beatport download queue">
            <header><strong>Beatport downloads</strong><button type="button" data-side aria-label="Move panel to other side">⇄</button><button type="button" data-close>Collapse</button></header>
            <label>New downloads<select data-mode><option value="library">Venus library</option><option value="local">Local only</option></select></label>
            <small data-venus hidden>Connecting requires home Wi-Fi.</small>
            <small data-pairing-status></small>
            <button type="button" data-auto-pair>Pair this browser</button>
            <div data-message role="status" aria-live="polite">Start the helper to see your saved queue.</div>
            <small data-sleep hidden></small>
            <div class="actions"><button type="button" data-wake>Start / reconnect</button><button type="button" data-pause>Pause after current job</button><button type="button" data-connect disabled>Venus · not checked</button><button type="button" data-retry-failed hidden>Retry failed jobs</button></div>
            <div data-jobs></div>
            <details data-history><summary data-history-title>History</summary>
              <div class="actions"><button type="button" data-clear-completed hidden>Clear completed</button><button type="button" data-clear-failed hidden>Clear failed</button></div>
              <small>Only the 10 latest entries are shown. Clearing hides finished and failed jobs; files and the retry log stay untouched.</small>
              <div data-history-jobs></div>
            </details>
            <details><summary>Add a list of links</summary><label>One Beatport URL per line<textarea data-links rows="4"></textarea></label><button type="button" data-add>Queue list</button></details>
            <details data-pair><summary>Advanced connection settings</summary><button type="button" data-repair-pair>Pair this browser again</button>
              <small>Automatic setup opens your private local installer. Manual code entry is only a fallback.</small>
              <label>Private pairing code<input data-token type="password" autocomplete="off" spellcheck="false"></label><button type="button" data-save>Save pairing</button></details>
          </section>`;
        const find = selector => queuePanel.querySelector(selector);
        pairingStatus(loaderConfig.getHelperToken?.() ? 'saved' : 'missing');
        find('[data-history]').addEventListener('toggle', updateQueueAttention);
        try {
            if (typeof GM_addValueChangeListener === 'function') {
                GM_addValueChangeListener(QUEUE_ERROR_SEEN_KEY, (_key, oldValue, newValue, remote) => {
                    if (!remote) return; // Our local state already includes this write.
                    // Include the overwritten value and read current storage too:
                    // notifications may arrive after another tab has written again.
                    syncQueueErrorsSeen(oldValue, newValue);
                    updateQueueAttention(); // Repaint cached status; never wake/poll the helper.
                });
            }
        } catch {}
        find('[data-retry-failed]').addEventListener('click', () => {
            const count = queueLastSnapshot?.retryable_count || 0;
            if (count && window.confirm(`Retry ${count} failed job(s), including older failures in saved history? Each keeps its original destination and resumes from its saved stage. Finished files will not be downloaded again.`)) panelAction('/retry-failed');
        });
        find('[data-auto-pair]').addEventListener('click', requestBrowserPairing);
        find('[data-repair-pair]').addEventListener('click', requestBrowserPairing);
        for (const kind of ['completed','failed']) find(`[data-clear-${kind}]`).addEventListener('click', () => {
            if (window.confirm(`Clear ${kind} entries from history? Downloaded files, saved jobs and the retry log will be kept. Unfinished transfers stay visible.`)) panelAction(`/history/clear-${kind}`);
        });
        find('[data-mode]').value = loaderConfig.localOnly ? 'local' : 'library';
        find('[data-mode]').addEventListener('change', event => loaderConfig.setLocalOnly(event.target.value === 'local'));
        loaderConfig.onModeChange?.(() => { find('[data-mode]').value = loaderConfig.localOnly ? 'local' : 'library'; });
        find('[data-toggle]').addEventListener('click', () => setQueueOpen(find('[data-panel]').hidden));
        find('[data-close]').addEventListener('click', () => setQueueOpen(false));
        find('[data-side]').addEventListener('click', () => {
            const left = queueHost.style.right !== 'auto';
            queueHost.style.right = left ? 'auto' : '8px'; queueHost.style.left = left ? '8px' : 'auto';
        });
        find('[data-wake]').addEventListener('click', () => {
            if (!loaderConfig.getHelperToken?.()) { pairingStatus('missing'); queueMessage('Click Pair this browser for automatic setup.', true); return; }
            wakeQueue().then(() => helperRequest('/resume', {})).then(pollQueue).catch(error => queueMessage(error.message, true));
        });
        find('[data-save]').addEventListener('click', () => {
            const token = find('[data-token]').value.trim();
            if (!/^[a-f0-9]{64}$/.test(token)) return queueMessage('Enter the 64-character private pairing code.', true);
            loaderConfig.setHelperToken(token); find('[data-token]').value = ''; find('[data-pair]').open = false;
            pairingStatus('saved');
            queueMessage('Paired. Click Start / reconnect.');
        });
        find('[data-pause]').addEventListener('click', () => panelAction(queueLastSnapshot?.paused ? '/resume' : '/pause'));
        find('[data-connect]').addEventListener('click', () => panelAction('/connect'));
        find('[data-add]').addEventListener('click', () => {
            const urls = find('[data-links]').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            if (!urls.length) return queueMessage('Paste at least one Beatport link.', true);
            queueAPI('/jobs', { urls, mode: loaderConfig.localOnly ? 'local' : 'library' }).then(() => {
                find('[data-links]').value = ''; queueMessage('List queued'); pollQueue();
            }).catch(error => queueMessage(error.message, true));
        });
        // Typing in our controls must not trigger Beatport's keyboard player shortcuts.
        queuePanel.addEventListener('keydown', event => { if (event.key === 'Escape') setQueueOpen(false); event.stopPropagation(); });
        window.addEventListener('pointerdown', event => { if (!event.composedPath().includes(queueHost)) setQueueOpen(false); }, { passive:true });
        window.addEventListener('keydown', event => { if (event.key === 'Escape') setQueueOpen(false); });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) suspendQueuePolling();
            else resumeQueuePolling();
        });
        window.addEventListener('pagehide', () => {
            queuePageHidden = true;
            suspendQueuePolling();
        }, { passive: true });
        window.addEventListener('pageshow', event => {
            queuePageHidden = false;
            if (event.persisted) resumeQueuePolling();
        }, { passive: true });
        document.documentElement.appendChild(queueHost);
        instance.showQueue = () => setQueueOpen(true);
        // Discover an already-awake helper without launching anything. This
        // avoids app prompts just because a new Beatport page was opened.
        if (loaderConfig.getHelperToken?.()) helperRequest('/jobs').then(renderQueue).catch(() => {});
    }

    function start() {
        if (instance.started) return;
        instance.started = true;
        addIconStyles();
        pruneSubmissionStorage();
        reconcileModeControl();
        if (loaderConfig.helperEnabled) ensureQueuePanel();
        loaderConfig.onModeChange?.(reconcileModeControl);
        window.addEventListener('focus', refreshSubmissionIcons);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) refreshSubmissionIcons();
        });
        enhanceBeatportLinks();
        reconcilePageAction();
        titleDirty = false;

        const observer = new MutationObserver(handleMutations);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href'],
            characterData: true,
        });
        instance.observer = observer;
        installNavigationHooks();
        window.addEventListener('resize', scheduleTitlePosition, { passive: true });
        window.addEventListener('pagehide', cleanupObjectUrls, { passive: true });
        document.fonts?.ready?.then(scheduleTitlePosition).catch?.(() => {});
        document.fonts?.addEventListener?.('loadingdone', scheduleTitlePosition);
    }

    instance.testHooks = {
        installSafariPlaybackFix,
        submissionTime,
        recordSubmission,
        pruneSubmissionStorage,
        titleMutation,
        buildHazelJob,
        claimJob,
        cleanupObjectUrls,
        claimCurrentIcon,
        createFrameBatcher,
        createHazelJob,
        confirmLargeJob,
        copyMediaUrl,
        getBeatportMediaUrl,
        handleMutations,
        isAnchorNode,
        isElementNode,
        instance,
        mediaKey,
        preferredMediaLink,
        pruneRoots,
        wrapHistoryMethod,
    };

    if (TEST_CONFIG) globalThis.__TM_BEATPORTDL_TEST_HOOKS__ = instance.testHooks;
    if (TEST_CONFIG?.skipStart) {
        globalThis[INSTANCE_KEY] = instance;
        return;
    }
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
    // Publish the singleton only after synchronous startup succeeds. If a newly
    // cached core throws during startup, the loader can still execute its rollback.
    globalThis[INSTANCE_KEY] = instance;
})();
