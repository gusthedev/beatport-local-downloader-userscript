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
- On Safari 27 only, selects standard MediaSource buffering for Beatport's signed-in HLS player to prevent seeks beyond the buffered audio from freezing. Chrome and other browser versions are untouched; no browser security or privacy settings are changed.

## Installation

Current versions on `main`:

| Component | Version | How it is installed and updated |
| --- | --- | --- |
| Loader (`beatport-local-loader.user.js`) | **1.5.2** | Installed and updated by Tampermonkey. |
| Shared core (`beatport-local-hazel.user.js`) | **1.9.2** | Downloaded, validated, and cached by the loader. |

Install [`beatport-local-loader.user.js`](https://raw.githubusercontent.com/gusthedev/beatport-local-downloader-userscript/main/beatport-local-loader.user.js) in Tampermonkey once. The loader installs the shared core automatically; do not install the core as a second userscript.

Disable or remove older copies of **Beatport Local FLAC Download (Hazel)** after enabling the loader to avoid running two copies at once.

## Updates

If you have an older loader, update it to **1.5.2** through Tampermonkey or open the loader installation link above, then reload Beatport. The loader and shared core have separate version numbers and update paths:

- **Shared core:** Loader 1.5.2 fetches `beatport-local-hazel.user.js` from `main` through the GitHub Contents API at `api.github.com`, using the raw-source response format. This avoids the stale branch revisions that the `raw.githubusercontent.com` edge can serve. The loader's `@connect` permission covers `api.github.com`.
- **Loader itself:** Tampermonkey's `@updateURL` and `@downloadURL` remain unchanged and point to `beatport-local-loader.user.js` on `raw.githubusercontent.com`. A shared-core update does not update the installed loader or its permissions.

On first use, the loader downloads, validates, and starts the shared core. After that it starts the cached last-known-good core immediately at `document-start` and keeps working from cache if GitHub is unavailable. With an active core, automatic update checks on page load run at most hourly using conditional requests. A newer core is cached for the next Beatport page load.

To fetch the current core immediately, use Tampermonkey's **Check for shared-core updates now** menu command, then reload Beatport. Use **Show shared-core status** to check the active, cached, and rollback versions; the current core is **1.9.2**. Other menu commands toggle artist/label confirmation or switch new jobs between normal and local-only routing.

### Safari 27 playback

The current loader grants access to Beatport's page player through `unsafeWindow`, which the core uses for the Safari 27 playback fix. On Safari 27 only, the fix selects standard MediaSource buffering for Beatport's signed-in HLS player to prevent seeks beyond the buffered audio from freezing. Chrome and other browser versions are untouched; no browser security or privacy settings are changed. Credentials remain local and are neither read nor sent by the fix.

Remove the temporary standalone **Beatport Safari Playback Fix** if previously installed, then reload Beatport. When the core starts after playback has already begun, the corrected buffering preference takes effect on the next track load.

### Historical upgrade notes

These notes describe when features were introduced, not the versions to install today. Use the current versions listed above.

- **Loader 1.5.0:** Added support for cross-tab indicators and the visible mode switch. Older loaders continued to support download buttons with their existing routing settings. Storage listeners are released when their media controls leave the page.
- **Loader 1.5.1 / core 1.9.1:** Introduced the Safari 27 playback fix and the loader's `unsafeWindow` grant. Both remain included in the current versions.

## Privacy

The repository contains no Beatport username, password, tokens, filesystem paths, or BeatportDL configuration. The public job contains only a canonical Beatport URL and an optional local-only marker in its filename; credentials, destinations, and download processing remain local to the Mac.

## Development checks

Run `npm ci` followed by `npm test` with Node.js 18 or newer. The tests (including jsdom browser fixtures) cover accepted and rejected Beatport URLs, canonicalization, cross-browser DOM wrappers, mutation batching, single-page navigation, singleton and rollback behavior, manual cache bypass, Hazel job format, copy/confirmation behavior, duplicate prevention, and temporary URL cleanup.
