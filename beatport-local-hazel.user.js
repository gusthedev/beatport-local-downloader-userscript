// ==UserScript==
// @name         Beatport Local FLAC Download (Hazel)
// @namespace    local.beatportdl.hazel
// @version      1.5.3
// @description  Adds local BeatportDL buttons for tracks, releases, playlists, charts, labels, and artists.
// @author       Gustavo
// @match        https://www.beatport.com/*
// @match        https://beatport.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const ICON_CLASS = 'tm-beatportdl-local-icon';
    const TITLE_ICON_CLASS = 'tm-beatportdl-page-title-icon';
    const TITLE_WRAP_CLASS = 'tm-beatportdl-page-title-wrap';

    function getBeatportMediaUrl(value) {
        try {
            if (!value || /^[#?]/.test(value.trim())) return null;

            const url = new URL(value, location.href);
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
            url.hostname = 'www.beatport.com';
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
        if (!(link instanceof HTMLAnchorElement)) return null;
        if (!link.closest('main') && !link.closest('[class*="Player-style__"]')) return null;
        return getBeatportMediaUrl(link.getAttribute('href'));
    }

    function cleanupIcons(root = document) {
        if (!root.querySelectorAll) return;

        root.querySelectorAll(`.${ICON_CLASS}`).forEach((icon) => {
            if (icon.classList.contains(TITLE_ICON_CLASS)) {
                const heading = icon.previousElementSibling;
                const pageMedia = getBeatportMediaUrl(location.href);

                if (!['release', 'track'].includes(pageMedia?.type) || heading?.tagName !== 'H1') {
                    icon.parentElement?.classList.remove(TITLE_WRAP_CLASS);
                    icon.remove();
                }
                return;
            }

            const link = icon.previousElementSibling;
            const media = getEligibleMedia(link);
            const containsArtwork = Boolean(link?.querySelector?.('img, picture'));

            if (!media || !link.textContent.trim() || containsArtwork) {
                icon.remove();
            }
        });
    }

    function createHazelJob(media, icon) {
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17);
        const filename = `beatportdl-${media.type}-${media.id}-${timestamp}.txt`;
        const blob = new Blob([`${media.url}\n`], { type: 'text/plain;charset=utf-8' });
        const objectUrl = URL.createObjectURL(blob);
        const download = document.createElement('a');

        download.href = objectUrl;
        download.download = filename;
        download.style.display = 'none';
        document.documentElement.appendChild(download);
        download.click();
        download.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

        icon.textContent = '✓';
        icon.classList.add('tm-beatportdl-local-queued');
        window.setTimeout(() => {
            icon.textContent = '⇩';
            icon.classList.remove('tm-beatportdl-local-queued');
        }, 2500);
    }

    function enhanceLink(link) {
        if (!(link instanceof HTMLAnchorElement)) return;
        if (link.classList.contains(ICON_CLASS)) return;

        const media = getEligibleMedia(link);
        const existingIcon = link.nextElementSibling?.classList.contains(ICON_CLASS)
            ? link.nextElementSibling
            : null;
        const containsArtwork = Boolean(link.querySelector('img, picture'));

        if (!media || !link.textContent.trim() || containsArtwork) {
            existingIcon?.remove();
            return;
        }

        const label = link.textContent.trim();
        const icon = existingIcon || document.createElement('button');
        icon.className = ICON_CLASS;
        icon.classList.toggle('tm-beatportdl-label-icon', media.type === 'label');
        icon._tmBeatportMedia = media;
        icon.type = 'button';
        icon.title = 'Download locally as FLAC with BeatportDL';
        icon.setAttribute('aria-label', `Download ${label} locally as FLAC`);

        if (!existingIcon) {
            icon.textContent = '⇩';
            icon.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                createHazelJob(icon._tmBeatportMedia, icon);
            });
            link.insertAdjacentElement('afterend', icon);
        }
    }

    function positionPageTitleIcon(heading, icon) {
        const parent = heading.parentElement;
        if (!parent) return;

        const range = document.createRange();
        range.selectNodeContents(heading);
        const textRects = Array.from(range.getClientRects()).filter((rect) => rect.width && rect.height);
        const textRect = textRects[textRects.length - 1] || heading.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        const iconSize = 16;
        const gap = 10;
        const left = Math.max(0, textRect.right - parentRect.left + gap);
        const top = Math.max(0, textRect.top - parentRect.top + ((textRect.height - iconSize) / 2));

        icon.style.setProperty('--tm-beatportdl-title-left', `${left}px`);
        icon.style.setProperty('--tm-beatportdl-title-top', `${top}px`);
    }

    function enhancePageTitle() {
        const media = getBeatportMediaUrl(location.href);
        if (!['release', 'track'].includes(media?.type)) return;

        const heading = document.querySelector(
            'main h1[class*="ReleaseDetailCard-style__Name"], main h1[class*="TrackDetail"], main h1',
        );
        const parent = heading?.parentElement;
        if (!heading || !parent || !heading.textContent.trim()) return;

        let icon = heading.nextElementSibling?.classList.contains(TITLE_ICON_CLASS)
            ? heading.nextElementSibling
            : null;

        if (!icon) {
            icon = document.createElement('button');
            icon.className = `${ICON_CLASS} ${TITLE_ICON_CLASS}`;
            icon.type = 'button';
            icon.textContent = '⇩';
            icon.title = 'Download this item locally as FLAC with BeatportDL';
            icon.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                createHazelJob(icon._tmBeatportMedia, icon);
            });
            heading.insertAdjacentElement('afterend', icon);
        }

        parent.classList.add(TITLE_WRAP_CLASS);
        icon._tmBeatportMedia = media;
        const itemDescription = media.type === 'release' ? 'full release' : 'track';
        icon.title = `Download this ${itemDescription} locally as FLAC with BeatportDL`;
        icon.setAttribute('aria-label', `Download the ${itemDescription} ${heading.textContent.trim()} locally as FLAC`);
        positionPageTitleIcon(heading, icon);
    }

    function addIconStyles() {
        if (document.getElementById('tm-beatportdl-local-styles')) return;

        const style = document.createElement('style');
        style.id = 'tm-beatportdl-local-styles';
        style.textContent = `
            .${ICON_CLASS} {
                align-items: center;
                align-self: center;
                appearance: none;
                background: #01ff95;
                border: 0 !important;
                border-radius: 50%;
                box-sizing: border-box !important;
                color: #09130f !important;
                cursor: pointer;
                display: inline-flex;
                flex: 0 0 16px !important;
                font: 800 12px/1 system-ui, sans-serif;
                height: 16px !important;
                inset: auto !important;
                justify-content: center;
                margin: 0 0 0 5px !important;
                max-height: 16px !important;
                max-width: 16px !important;
                min-height: 16px !important;
                min-width: 16px !important;
                opacity: 0.72;
                overflow: hidden;
                padding: 0 !important;
                position: static !important;
                transition: opacity 120ms ease, transform 120ms ease;
                vertical-align: middle;
                white-space: nowrap;
                width: 16px !important;
            }

            .${ICON_CLASS}:hover,
            .${ICON_CLASS}:focus-visible {
                opacity: 1;
                transform: scale(1.12);
            }

            .${ICON_CLASS}.tm-beatportdl-local-queued {
                background: #ffffff;
                opacity: 1;
            }

            .${TITLE_WRAP_CLASS} {
                position: relative !important;
            }

            .${ICON_CLASS}.${TITLE_ICON_CLASS} {
                align-self: auto;
                left: var(--tm-beatportdl-title-left) !important;
                margin: 0 !important;
                position: absolute !important;
                top: var(--tm-beatportdl-title-top) !important;
                z-index: 2;
            }

            *:has(> .${ICON_CLASS}.tm-beatportdl-label-icon) {
                align-items: center !important;
                display: flex !important;
                flex-flow: row nowrap !important;
            }

            *:has(> .${ICON_CLASS}.tm-beatportdl-label-icon) > a {
                flex: 0 1 auto !important;
                min-width: 0 !important;
                width: auto !important;
            }
        `;
        document.documentElement.appendChild(style);
    }

    function enhanceBeatportLinks(root = document) {
        if (root instanceof HTMLAnchorElement) enhanceLink(root);
        if (root.querySelectorAll) root.querySelectorAll('a[href]').forEach(enhanceLink);
    }

    function start() {
        addIconStyles();
        cleanupIcons();
        enhanceBeatportLinks();
        enhancePageTitle();

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.target instanceof HTMLAnchorElement) enhanceLink(mutation.target);
                for (const node of mutation.addedNodes) {
                    if (node instanceof Element) enhanceBeatportLinks(node);
                }
            }
            enhancePageTitle();
            cleanupIcons();
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href'],
        });

        window.addEventListener('resize', enhancePageTitle, { passive: true });
    }

    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
