# Beatport Local Download Userscript

This repository contains Gustavo's public Beatport-to-BeatportDL userscript. It creates a small local `.txt` job that Hazel passes to the locally installed BeatportDL application.

## Features

- Adds local-download actions beside eligible track, release, playlist, chart, label, and artist links.
- Adds one page-title action for each supported Beatport media page, including library playlists.
- Reconciles controls during Beatport single-page navigation without repeatedly rescanning the entire document.
- Prevents rapid duplicate jobs and cleans temporary browser object URLs on a timer or when the page closes.
- Deduplicates repeated links within the same list row and supports Shift-click to copy a canonical Beatport URL.
- Shows accurate job-file-requested/copied feedback and confirms potentially large artist or label catalog jobs by default.
- Remembers recently submitted items for 24 hours across navigation and tabs, and confirms deliberate resubmission. This records a requested job file, not downloader completion.
- Processes repeated row links once per batch and limits title-control work to relevant changes.
- Provides a visible, persistent local-only toggle synchronized with the loader menu. Local automation can route those marked jobs to an isolated folder instead of its normal library-ingest workflow.

## Installation

Install [`beatport-local-loader.user.js`](https://raw.githubusercontent.com/gusthedev/beatport-local-downloader-userscript/main/beatport-local-loader.user.js) in Tampermonkey once.

On first use, the loader downloads and validates the shared core. After that it starts the cached last-known-good core immediately at `document-start`, checks GitHub at most hourly using conditional requests, and keeps working from cache if GitHub is unavailable. A newer core takes effect on the next Beatport page load. Tampermonkey menu commands can bypass caches for a core update, show cache and rollback status, toggle artist/label confirmation, or switch new jobs between normal and local-only routing.

The loader itself has separate Tampermonkey update metadata pointing to the loader file, so later loader-mechanism changes can update without replacing it with the core.

Disable or remove older copies of **Beatport Local FLAC Download (Hazel)** after enabling the loader to avoid running two copies at once.

## Privacy

The repository contains no Beatport username, password, tokens, filesystem paths, or BeatportDL configuration. The public job contains only a canonical Beatport URL and an optional local-only marker in its filename; credentials, destinations, and download processing remain local to the Mac.

## Development checks

Run `npm ci` followed by `npm test` with Node.js 18 or newer. The tests (including jsdom browser fixtures) cover accepted and rejected Beatport URLs, canonicalization, cross-browser DOM wrappers, mutation batching, single-page navigation, singleton and rollback behavior, manual cache bypass, Hazel job format, copy/confirmation behavior, duplicate prevention, and temporary URL cleanup.

Update the loader to 1.5.0 for cross-tab indicators and the visible mode switch. Older loaders continue to support download buttons with their existing routing settings. Storage listeners are released when their media controls leave the page.
