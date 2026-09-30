# Beatport Local Download Userscript

This repository contains the public browser side of a local Beatport download queue. With loader 1.6.2, the browser sends jobs directly to a privately paired on-demand helper. Hazel only wakes a sleeping helper using one temporary trigger; old loaders retain the legacy TXT workflow.

## Live queue panel

The panel starts collapsed near the top edge, away from the player. It can move to either side, collapses on outside clicks or Escape, and never places a full-page click-blocking backdrop over Beatport. It shows real queue stages, downloaded file/byte counts, per-job destination, failures and retries, and supports pasted batches and pausing after the current job. No fabricated percentage is shown. Delivered files are not described as already imported into a music app.

Current downloads remain in the main view. Finished and failed jobs appear in collapsed History, with only the latest 10 rendered and dated. Old failures do not set the top error badge. Clear history hides terminal entries without deleting audio, saved jobs, or retry logs; Undo clear restores their visibility. Pending downloads and files waiting for delivery are never hidden by clearing history.

The helper is installed separately; this public loader contains no pairing secret. Click **Pair this browser** when setup is needed: a temporary Hazel trigger asks the installed helper to open its private installer in your normal Safari or Chrome session (other browsers use the system default). Approve **Update** in Tampermonkey and reload Beatport. If it says **Reinstall** or warns about resetting settings, cancel. The helper gives each private pairing copy a newer fourth version component so it updates the existing script while preserving preferences; future public patch versions still sort higher. No secret needs to be copied, and later public updates preserve pairing. The button requires the current private helper; the local Install Beatport Loader.command remains a fallback. Advanced connection settings contains manual repair, but is not required when the panel says connected.

Requests use Tampermonkey's localhost grant and authenticated loopback requests. Status reads never launch or keep the helper alive. No always-running service is required; the local helper exits after its idle grace period. Browser downloads must save to the Hazel-watched Downloads folder for waking and automatic pairing to work.

The existing TXT batch/retry workflow remains supported by the local queue. Browser jobs no longer produce one TXT per track. An offline helper is not treated as a failed download; accepted work remains saved locally.

## Features

- Adds local-download actions beside eligible track, release, playlist, chart, label, and artist links.
- Adds one page-title action for each supported Beatport media page, including library playlists.
- Reconciles controls during Beatport single-page navigation without repeatedly rescanning the entire document.
- Prevents rapid duplicate jobs and cleans temporary browser object URLs on a timer or when the page closes.
- Deduplicates repeated links within the same list row and supports Shift-click to copy a canonical Beatport URL.
- Shows queue-accepted/copied feedback and confirms potentially large artist or label catalog jobs by default.
- Remembers recently submitted items for 24 hours across navigation and tabs, and confirms deliberate resubmission. This records submission, not downloader completion; the live panel reports completion separately.
- Processes repeated row links once per batch and limits title-control work to relevant changes.
- Provides a visible, persistent local-only toggle synchronized with the loader menu. Local automation can route those marked jobs to an isolated folder instead of its normal library-ingest workflow.
- On Safari 27 only, selects standard MediaSource buffering for Beatport's signed-in HLS player to prevent seeks beyond the buffered audio from freezing. Chrome and other browser versions are untouched; no browser security or privacy settings are changed.

## Installation

Current versions on `main`:

| Component | Version | How it is installed and updated |
| --- | --- | --- |
| Loader (`beatport-local-loader.user.js`) | **1.6.2** | Installed and updated by Tampermonkey. |
| Shared core (`beatport-local-hazel.user.js`) | **2.0.2** | Downloaded, validated, and cached by the loader. |

Install [`beatport-local-loader.user.js`](https://raw.githubusercontent.com/gusthedev/beatport-local-downloader-userscript/main/beatport-local-loader.user.js) in Tampermonkey once. The loader installs the shared core automatically; do not install the core as a second userscript.

Disable or remove older copies of **Beatport Local FLAC Download (Hazel)** after enabling the loader to avoid running two copies at once.

## Updates

If you have an older loader, update it to **1.6.2** through your private paired installer, then reload Beatport. Generic public installations require a separately installed and paired helper. The loader and shared core have separate version numbers and update paths:

- **Shared core:** Loader 1.6.2 retains the GitHub Contents API update fix from 1.5.2. It fetches `beatport-local-hazel.user.js` from `main` through `api.github.com`, using the raw-source response format. This avoids stale branch revisions from the raw edge. Its permissions cover `api.github.com` and the paired local helper at `127.0.0.1`.
- **Loader itself:** Tampermonkey's `@updateURL` and `@downloadURL` remain unchanged and point to `beatport-local-loader.user.js` on `raw.githubusercontent.com`. A shared-core update does not update the installed loader or its permissions.

On first use, the loader downloads, validates, and starts the shared core. After that it starts the cached last-known-good core immediately at `document-start` and keeps working from cache if GitHub is unavailable. With an active core, automatic update checks on page load run at most hourly using conditional requests. A newer core is cached for the next Beatport page load.

To fetch the current core immediately, use Tampermonkey's **Check for shared-core updates now** menu command, then reload Beatport. Use **Show shared-core status** to check the active, cached, and rollback versions; the current core is **2.0.2**. Other menu commands toggle artist/label confirmation, show the download panel, or switch new jobs between normal and local-only routing.

### Safari 27 playback

The current loader grants access to Beatport's page player through `unsafeWindow`, which the core uses for the Safari 27 playback fix. On Safari 27 only, the fix selects standard MediaSource buffering for Beatport's signed-in HLS player to prevent seeks beyond the buffered audio from freezing. Chrome and other browser versions are untouched; no browser security or privacy settings are changed. Credentials remain local and are neither read nor sent by the fix.

Remove the temporary standalone **Beatport Safari Playback Fix** if previously installed, then reload Beatport. When the core starts after playback has already begun, the corrected buffering preference takes effect on the next track load.

### Historical upgrade notes

These notes describe when features were introduced, not the versions to install today. Use the current versions listed above.

- **Loader 1.5.0:** Added support for cross-tab indicators and the visible mode switch. Older loaders continued to support download buttons with their existing routing settings. Storage listeners are released when their media controls leave the page.
- **Loader 1.5.1 / core 1.9.1:** Introduced the Safari 27 playback fix and the loader's `unsafeWindow` grant. Both remain included in the current versions.

## Privacy

The repository contains no Beatport username, password, pairing tokens, personal filesystem paths, private network addresses, or BeatportDL configuration. The public code knows only a fixed loopback helper address. Credentials, destinations, network connection rules, queue history, and download processing remain local. Do not publish a locally paired loader.

## Development checks

Run `npm ci` followed by `npm test` with Node.js 18 or newer. The tests (including jsdom browser fixtures) cover accepted and rejected Beatport URLs, canonicalization, cross-browser DOM wrappers, mutation batching, single-page navigation, singleton and rollback behavior, manual cache bypass, Hazel job format, copy/confirmation behavior, duplicate prevention, and temporary URL cleanup.
