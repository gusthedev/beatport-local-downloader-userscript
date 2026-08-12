// ==UserScript==
// @name         Beatport Local Download Loader
// @namespace    local.beatportdl.hazel.loader
// @version      1.1.0
// @description  Loads the shared Beatport userscript maintained on GitHub.
// @author       Gustavo
// @match        https://www.beatport.com/*
// @match        https://beatport.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const sharedScriptUrl = `https://raw.githubusercontent.com/gusthedev/beatport-local-downloader-userscript/main/beatport-local-hazel.user.js?t=${Date.now()}`;

    GM_xmlhttpRequest({
        method: 'GET',
        url: sharedScriptUrl,
        headers: {
            'Cache-Control': 'no-cache',
        },
        onload(response) {
            if (response.status !== 200) {
                console.error(`[Beatport loader] GitHub script returned HTTP ${response.status}.`);
                return;
            }

            try {
                eval(`${response.responseText}\n//# sourceURL=beatport-local-hazel.user.js`);
            } catch (error) {
                console.error('[Beatport loader] Could not start the GitHub script.', error);
            }
        },
        onerror(error) {
            console.error('[Beatport loader] GitHub script is unavailable.', error);
        },
    });
})();
