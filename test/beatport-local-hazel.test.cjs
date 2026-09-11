const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'beatport-local-hazel.user.js'), 'utf8');

const safari27 = 'Mozilla/5.0 (Macintosh) AppleWebKit/625 Version/27.0 Safari/625';

function safariPlayerFixture({ active = false } = {}) {
    class Hls {}
    Hls.DefaultConfig = { preferManagedMediaSource: true };
    let destroyed = 0;
    class Adapter {
        constructor(media, context, onError) {
            this.media = media;
            this.context = context;
            this.onError = onError;
            this._hls = { constructor: Hls, config: { ...Hls.DefaultConfig } };
        }
        destroy() { destroyed += 1; }
    }
    const media = {}, audioContext = {}, onError = () => {};
    const adapter = new Adapter(media, audioContext, onError);
    const player = {
        _mediaElement: media, _audioContext: audioContext, _onError: onError,
        _audioAdapters: { HlsAdapter: adapter },
        getTrack() { return active ? { id: 1 } : undefined; },
    };
    const page = { navigator: { userAgent: safari27 }, MediaSource: class {} };
    return { page, player, adapter, Hls, destroyed: () => destroyed };
}

test('Safari 27 player published after document-start uses standard buffering from its first stream', () => {
    const { hooks } = createContext();
    const f = safariPlayerFixture();
    hooks.installSafariPlaybackFix(f.page);
    f.page.BPPlayer = f.player;
    const replacement = f.player._audioAdapters.HlsAdapter;
    assert.notEqual(replacement, f.adapter);
    assert.equal(replacement._hls.config.preferManagedMediaSource, false);
    assert.equal(replacement.media, f.player._mediaElement);
    assert.equal(replacement.context, f.player._audioContext);
    assert.equal(replacement.onError, f.player._onError);
    assert.equal(f.destroyed(), 1);
    f.page.BPPlayer = f.player;
    hooks.installSafariPlaybackFix(f.page);
    assert.equal(f.destroyed(), 1);
    assert.equal(f.page.__beatportSafariPlaybackFix.applied, true);
});

test('Safari compatibility leaves active playback intact and configures subsequent HLS instances', () => {
    const { hooks } = createContext();
    const f = safariPlayerFixture({ active: true });
    f.page.BPPlayer = f.player;
    hooks.installSafariPlaybackFix(f.page);
    assert.equal(f.player._audioAdapters.HlsAdapter, f.adapter);
    assert.equal(f.destroyed(), 0);
    assert.equal(f.Hls.DefaultConfig.preferManagedMediaSource, false);
});

test('Safari compatibility does not change Chrome, older Safari, or browsers without standard MediaSource', () => {
    const { hooks } = createContext();
    for (const agent of [safari27.replace('27.0', '26.0'), 'Mozilla/5.0 Chrome/153.0 Safari/537.36']) {
        const f = safariPlayerFixture();
        f.page.navigator.userAgent = agent;
        hooks.installSafariPlaybackFix(f.page);
        assert.equal(f.page.__beatportSafariPlaybackFix, undefined);
        assert.equal(Object.getOwnPropertyDescriptor(f.page, 'BPPlayer'), undefined);
        assert.equal(f.Hls.DefaultConfig.preferManagedMediaSource, true);
    }
    const f = safariPlayerFixture();
    delete f.page.MediaSource;
    hooks.installSafariPlaybackFix(f.page);
    assert.equal(f.page.__beatportSafariPlaybackFix, undefined);
});

test('Safari compatibility preserves existing page-owned accessors and ignores incompatible players', () => {
    const { hooks } = createContext();
    const f = safariPlayerFixture({ active: true });
    const getter = () => f.player;
    Object.defineProperty(f.page, 'BPPlayer', { get: getter, configurable: false });
    hooks.installSafariPlaybackFix(f.page);
    assert.equal(Object.getOwnPropertyDescriptor(f.page, 'BPPlayer').get, getter);
    const other = safariPlayerFixture();
    hooks.installSafariPlaybackFix(other.page);
    other.page.BPPlayer = {};
    assert.equal(other.page.__beatportSafariPlaybackFix.applied, false);
});

function classList() {
    const values = new Set();
    return {
        add: (...names) => names.forEach((name) => values.add(name)),
        contains: (name) => values.has(name),
        remove: (...names) => names.forEach((name) => values.delete(name)),
        toggle(name, force) {
            const enabled = force === undefined ? !values.has(name) : force;
            if (enabled) values.add(name);
            else values.delete(name);
            return enabled;
        },
    };
}

function createContext({ confirmResult = true, localOnly = false } = {}) {
    const downloads = [];
    const copied = [];
    const revoked = [];
    const timers = new Map();
    let nextTimer = 1;
    let nextObjectUrl = 1;

    class TestElement {
        constructor(tagName = 'DIV') {
            this.nodeType = 1;
            this.tagName = tagName;
        }
        querySelectorAll() { return []; }
    }
    class TestAnchor extends TestElement {
        constructor() { super('A'); }
    }
    class TestURL extends URL {}
    TestURL.createObjectURL = () => `blob:test-${nextObjectUrl++}`;
    TestURL.revokeObjectURL = (value) => revoked.push(value);

    const documentElement = {
        appendChild(element) {
            element.isConnected = true;
            if (element.tagName === 'A') downloads.push(element);
        },
    };
    const document = {
        documentElement,
        getElementById() { return null; },
        createElement(tagName) {
            return {
                attributes: {},
                classList: classList(),
                click() { this.clicked = true; },
                download: '',
                href: '',
                hidden: false,
                id: '',
                remove() { this.removed = true; },
                setAttribute(name, value) { this.attributes[name] = value; },
                style: {},
                tagName: tagName.toUpperCase(),
            };
        },
    };
    const context = {
        Blob,
        Element: TestElement,
        HTMLAnchorElement: TestAnchor,
        URL: TestURL,
        BEATPORTDL_CONFIG: { localOnly },
        __TM_BEATPORTDL_TEST_MODE__: { skipStart: true },
        cancelAnimationFrame: () => {},
        clearTimeout(id) { timers.delete(id); },
        document,
        location: { href: 'https://www.beatport.com/' },
        requestAnimationFrame: () => 1,
        GM_setClipboard(value) { copied.push(value); },
        confirm: () => confirmResult,
        setTimeout(callback) {
            const id = nextTimer++;
            timers.set(id, callback);
            return id;
        },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'beatport-local-hazel.user.js' });
    return {
        context,
        copied,
        downloads,
        hooks: context.__TM_BEATPORTDL_TEST_HOOKS__,
        revoked,
        timers,
    };
}

function fakeIcon() {
    return {
        classList: classList(),
        disabled: false,
        textContent: '⇩',
    };
}

test('accepts and canonicalizes supported Beatport media URLs', () => {
    const { hooks } = createContext();
    const cases = [
        ['/track/name/123?utm=x#player', 'track', '123', 'https://www.beatport.com/track/name/123'],
        ['https://beatport.com/release/title/456/', 'release', '456', 'https://www.beatport.com/release/title/456/'],
        ['/playlist/my-list/789', 'playlist', '789', 'https://www.beatport.com/playlist/my-list/789'],
        ['/chart/my-chart/10', 'chart', '10', 'https://www.beatport.com/chart/my-chart/10'],
        ['/label/my-label/11', 'label', '11', 'https://www.beatport.com/label/my-label/11'],
        ['/artist/my-artist/12', 'artist', '12', 'https://www.beatport.com/artist/my-artist/12'],
        ['/library/playlists/13?x=1', 'playlist', '13', 'https://www.beatport.com/library/playlists/13'],
        ['http://user:secret@beatport.com:8080/track/title/14', 'track', '14', 'https://www.beatport.com/track/title/14'],
    ];

    for (const [input, type, id, expectedUrl] of cases) {
        const media = hooks.getBeatportMediaUrl(input);
        assert.equal(media.type, type);
        assert.equal(media.id, id);
        assert.equal(media.url, expectedUrl);
        assert.equal(media.url.includes('user:'), false);
        assert.equal(media.url.includes(':8080'), false);
    }
});

test('rejects unsupported hosts, malformed routes, and subresources', () => {
    const { hooks } = createContext();
    for (const value of [
        '', '#player', '?q=test', 'javascript:alert(1)',
        'https://evil.example/track/name/123',
        'https://www.beatport.com/track/name/not-a-number',
        'https://www.beatport.com/track/name/123/remix',
        'https://www.beatport.com/search?q=track',
    ]) {
        assert.equal(hooks.getBeatportMediaUrl(value), null, value);
    }
});

test('batches nested roots into one animation-frame flush', () => {
    const { hooks } = createContext();
    const frames = [];
    const flushes = [];
    const parent = { isConnected: true, contains: (node) => node === child };
    const child = { isConnected: true, contains: () => false };
    const batcher = hooks.createFrameBatcher((roots) => flushes.push(roots), (callback) => {
        frames.push(callback);
        return 1;
    });

    batcher.schedule(child);
    batcher.schedule(parent);
    batcher.schedule(child);
    assert.equal(frames.length, 1);
    frames[0]();
    assert.equal(flushes.length, 1);
    assert.equal(flushes[0].length, 1);
    assert.equal(flushes[0][0], parent);
});

test('history wrapper reconciles only when SPA navigation changes the URL', () => {
    const { context, hooks } = createContext();
    let reconciliations = 0;
    const fakeHistory = {
        pushState(_state, _title, nextUrl) {
            if (nextUrl) context.location.href = new URL(nextUrl, context.location.href).href;
            return 'result';
        },
    };
    hooks.wrapHistoryMethod(fakeHistory, 'pushState', () => { reconciliations += 1; });

    assert.equal(fakeHistory.pushState({}, '', null), 'result');
    assert.equal(reconciliations, 0);
    fakeHistory.pushState({}, '', '/release/new-name/99');
    assert.equal(context.location.href, 'https://www.beatport.com/release/new-name/99');
    assert.equal(reconciliations, 1);
});

test('singleton prevents a second initialization in the same page context', () => {
    const { context, hooks } = createContext();
    const firstInstance = hooks.instance;
    vm.runInContext(source, context, { filename: 'beatport-local-hazel-second-evaluation.user.js' });
    assert.equal(context.__TM_BEATPORTDL_TEST_HOOKS__.instance, firstInstance);
});

test('Hazel jobs retain the local text-file contract and reject rapid duplicates', () => {
    const { downloads, hooks, revoked } = createContext();
    const media = {
        id: '321',
        type: 'release',
        url: 'https://www.beatport.com/release/a-release/321',
    };
    const job = hooks.buildHazelJob(media, new Date('2026-08-12T21:22:23.456Z'));
    assert.deepEqual({ ...job }, {
        contents: 'https://www.beatport.com/release/a-release/321\n',
        filename: 'beatportdl-release-321-20260812212223456.txt',
    });

    assert.equal(hooks.claimJob({ ...media, id: '322' }, 1000), true);
    assert.equal(hooks.claimJob({ ...media, id: '322' }, 1200), false);
    assert.equal(hooks.claimJob({ ...media, id: '322' }, 2500), true);

    const icon = fakeIcon();
    assert.equal(hooks.createHazelJob(media, icon), true);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].clicked, true);
    assert.equal(downloads[0].removed, true);
    assert.equal(downloads[0].download.startsWith('beatportdl-release-321-'), true);
    assert.equal(icon.disabled, true);
    assert.equal(hooks.createHazelJob(media, fakeIcon()), false);
    hooks.cleanupObjectUrls();
    assert.deepEqual(revoked, ['blob:test-1']);
});

test('local-only mode changes only the routing marker in the job filename', () => {
    const { downloads, hooks } = createContext({ localOnly: true });
    const media = {
        id: '654',
        type: 'track',
        url: 'https://www.beatport.com/track/a-track/654',
    };
    const job = hooks.buildHazelJob(media, new Date('2026-08-12T21:22:23.456Z'));
    assert.deepEqual({ ...job }, {
        contents: 'https://www.beatport.com/track/a-track/654\n',
        filename: 'beatportdl-localonly-track-654-20260812212223456.txt',
    });
    assert.equal(hooks.createHazelJob(media, fakeIcon()), true);
    assert.equal(downloads[0].download.startsWith('beatportdl-localonly-track-654-'), true);
});

test('stale buttons are replaced so an older click handler cannot keep control', () => {
    const { hooks } = createContext({ localOnly: true });
    let removed = false;
    const staleIcon = {
        classList: classList(),
        dataset: { tmBeatportCoreVersion: '1.7.0' },
        parentElement: null,
        remove() { removed = true; },
    };
    assert.equal(hooks.claimCurrentIcon(staleIcon), null);
    assert.equal(removed, true);

    const currentIcon = {
        dataset: { tmBeatportCoreVersion: source.match(/const CORE_VERSION = '([^']+)'/)[1] },
    };
    assert.equal(hooks.claimCurrentIcon(currentIcon), currentIcon);
});

test('recognizes cross-realm anchor wrappers without instanceof checks', () => {
    const { hooks } = createContext();
    const anchor = {
        nodeType: 1,
        tagName: 'a',
        querySelectorAll() {},
    };
    assert.equal(hooks.isElementNode(anchor), true);
    assert.equal(hooks.isAnchorNode(anchor), true);
});

test('Shift-click copy and large-catalog confirmation are available', () => {
    const { copied, hooks } = createContext();
    const media = {
        id: '42',
        type: 'artist',
        url: 'https://www.beatport.com/artist/example/42',
    };
    const icon = fakeIcon();
    assert.equal(hooks.confirmLargeJob(media), true);
    assert.equal(hooks.copyMediaUrl(media, icon), true);
    assert.deepEqual(copied, [media.url]);
    assert.equal(icon.disabled, true);
});

test('large catalog jobs can be cancelled before a Hazel file is created', () => {
    const { hooks } = createContext({ confirmResult: false });
    assert.equal(hooks.confirmLargeJob({
        id: '42',
        type: 'label',
        url: 'https://www.beatport.com/label/example/42',
    }), false);
});

test('chooses one best text link for repeated media within a row', () => {
    const { hooks } = createContext();
    const item = { querySelectorAll: () => [shortLink, descriptiveLink] };
    const makeLink = (text) => ({
        nodeType: 1,
        tagName: 'A',
        textContent: text,
        getAttribute: () => '/track/example/42',
        querySelector: () => null,
        querySelectorAll: () => [],
        closest(selector) {
            return selector.includes('main') ? { nodeType: 1 } : item;
        },
    });
    const shortLink = makeLink('Track');
    const descriptiveLink = makeLink('Track Name (Extended Mix)');
    const media = hooks.getBeatportMediaUrl('/track/example/42');
    assert.equal(hooks.preferredMediaLink(shortLink, media), descriptiveLink);
    assert.equal(hooks.preferredMediaLink(descriptiveLink, media), descriptiveLink);
});
