// ==UserScript==
// @name         Beatport Local FLAC Download (Hazel)
// @namespace    local.beatportdl.hazel
// @version      1.7.0
// @description  Adds local BeatportDL buttons for tracks, releases, playlists, charts, labels, and artists.
// @author       Gustavo
// @match        https://www.beatport.com/*
// @match        https://beatport.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const INSTANCE_KEY = Symbol.for('tm.beatportdl.local.instance');
    const TEST_CONFIG = globalThis.__TM_BEATPORTDL_TEST_MODE__;
    const loaderConfig = typeof globalThis.BEATPORTDL_CONFIG === 'object' && globalThis.BEATPORTDL_CONFIG
        ? globalThis.BEATPORTDL_CONFIG
        : {};
    const existingInstance = globalThis[INSTANCE_KEY];

    if (existingInstance) {
        if (TEST_CONFIG) globalThis.__TM_BEATPORTDL_TEST_HOOKS__ = existingInstance.testHooks;
        return;
    }

    const ICON_CLASS = 'tm-beatportdl-local-icon';
    const TITLE_ICON_CLASS = 'tm-beatportdl-page-title-icon';
    const TITLE_WRAP_CLASS = 'tm-beatportdl-page-title-wrap';
    const LABEL_PARENT_CLASS = 'tm-beatportdl-label-parent';
    const STATUS_ID = 'tm-beatportdl-status';
    const OWNED_ATTRIBUTE = 'data-tm-beatportdl-owned';
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

    function clearFeedback(icon, reset = false) {
        const timer = instance.feedbackTimers.get(icon);
        if (timer) window.clearTimeout(timer);
        instance.feedbackTimers.delete(icon);
        if (reset) {
            icon.disabled = false;
            icon.textContent = '⇩';
            icon.classList.remove('tm-beatportdl-local-queued', 'tm-beatportdl-local-error');
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

    function buildHazelJob(media, date = new Date()) {
        const timestamp = date.toISOString().replace(/[^0-9]/g, '').slice(0, 17);
        return {
            contents: `${media.url}\n`,
            filename: `beatportdl-${media.type}-${media.id}-${timestamp}.txt`,
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
            setFeedback(icon, true);
            showStatus(`Queued ${job.filename}`);
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

    function preferredMediaLink(link, media) {
        const item = semanticItem(link);
        if (!item) return link;
        const candidates = Array.from(item.querySelectorAll('a[href]')).filter((candidate) => {
            const candidateMedia = getEligibleMedia(candidate);
            return candidateMedia && mediaKey(candidateMedia) === mediaKey(media) && candidate.textContent.trim();
        });
        return candidates.reduce((best, candidate) => {
            const score = (candidate.querySelector('img, picture') ? -1000 : 0)
                + Math.min(candidate.textContent.trim().length, 80)
                + (candidate.querySelector('h1, h2, h3, h4') ? 200 : 0);
            const bestScore = (best.querySelector('img, picture') ? -1000 : 0)
                + Math.min(best.textContent.trim().length, 80)
                + (best.querySelector('h1, h2, h3, h4') ? 200 : 0);
            return score > bestScore ? candidate : best;
        }, link);
    }

    function enhanceLink(link) {
        if (!isAnchorNode(link) || link.classList.contains(ICON_CLASS)) return;

        const media = getEligibleMedia(link);
        const icons = adjacentLinkIcons(link);
        const existingIcon = icons.shift() || null;
        icons.forEach(removeIcon);
        const containsArtwork = Boolean(link.querySelector('img, picture'));

        if (!media || !link.textContent.trim() || containsArtwork || preferredMediaLink(link, media) !== link) {
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
        icon.dataset.tmBeatportMediaKey = mediaKey(media);
        icon._tmBeatportMedia = media;
        icon.title = 'Queue a local FLAC download with BeatportDL (Shift-click copies the URL)';
        icon.setAttribute('aria-label', `Queue ${label} for local FLAC download; Shift-click copies its URL`);
        updateLabelParent(icon.parentElement);
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

    function enhanceBeatportLinks(root = document) {
        if (isAnchorNode(root)) enhanceLink(root);
        if (root.querySelectorAll) root.querySelectorAll('a[href]').forEach(enhanceLink);
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
        let icon = candidates.find((candidate) => candidate.previousElementSibling === heading) || null;
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
        icon.dataset.tmBeatportMediaKey = mediaKey(media);
        icon._tmBeatportMedia = media;
        const description = itemDescription(media);
        icon.title = `Queue this ${description} for local FLAC download with BeatportDL`;
        icon.setAttribute('aria-label', `Queue the ${description} ${heading.textContent.trim()} for local FLAC download`);
        if (titleChanged || !instance.resizeObserver) observeTitleSize(heading, parent);
        scheduleTitlePosition();
    }

    function flushRoots(roots) {
        for (const root of roots) enhanceBeatportLinks(root);
        reconcilePageAction();
    }

    const batcher = createFrameBatcher(flushRoots);

    function mutationRoot(node) {
        if (isElementNode(node) || node === document) return node;
        return node?.parentElement || null;
    }

    function handleMutations(mutations) {
        for (const mutation of mutations) {
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
                background: #0b2018; border: 1px solid #01ff95; border-radius: 7px; bottom: 18px;
                color: #fff; font: 600 13px/1.35 system-ui, sans-serif; left: 50%; max-width: min(520px, 88vw);
                padding: 8px 12px; position: fixed; transform: translateX(-50%); z-index: 2147483647;
            }
            #${STATUS_ID}.tm-beatportdl-status-error { border-color: #ff6b6b; }
            #${STATUS_ID}[hidden] { display: none !important; }
        `;
        document.documentElement.appendChild(style);
    }

    function start() {
        if (instance.started) return;
        instance.started = true;
        addIconStyles();
        enhanceBeatportLinks();
        reconcilePageAction();

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
        buildHazelJob,
        claimJob,
        cleanupObjectUrls,
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
