const { JSDOM } = require('jsdom');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'beatport-local-hazel.user.js'), 'utf8');
const safari27 = 'Mozilla/5.0 (Macintosh) Version/27.0 Safari/605.1.15';

function setup(t, agent = safari27, localOnly = false) {
    const dom = new JSDOM('<main><a href="/track/test/123">Track</a><button>⇩</button></main>', {
        url: 'https://www.beatport.com/track/test/123', runScripts: 'outside-only',
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    Object.defineProperty(w.navigator, 'userAgent', { value: agent });
    w.__TM_BEATPORTDL_TEST_MODE__ = { skipStart: true };
    w.GM_getValue = (key, fallback) => fallback;
    w.BEATPORTDL_CONFIG = { helperEnabled: true, localOnly, getHelperToken: () => 'a'.repeat(64),
        setHelperToken() {}, setLocalOnly() {}, onModeChange() {} };
    w.eval(source);
    const hooks = w.__TM_BEATPORTDL_TEST_HOOKS__;
    const icon = w.document.querySelector('button');
    icon._tmBeatportMedia = { type: 'track', id: '123', url: 'https://www.beatport.com/track/test/123' };
    const calls = [], listeners = new Map();
    const guard = hooks.createSafariMouseActivation(icon, event => calls.push(event));
    const event = (type, fields = {}) => ({ type, target: icon, isTrusted: true, pointerType: 'mouse',
        isPrimary: true, button: 0, pointerId: 1, clientX: 20, clientY: 30, detail: 1,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...fields });
    const fire = (type, fields) => guard.handle(event(type, fields));
    function bind() {
        const add = icon.addEventListener.bind(icon);
        icon.addEventListener = (type, fn, options) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn); add(type, fn, options);
        };
        hooks.bindMediaAction(icon);
    }
    function dispatch(type, fields) {
        const value = event(type, fields);
        for (const listener of listeners.get(type) || []) listener(value);
        return value;
    }
    return { w, hooks, icon, calls, guard, event, fire, bind, dispatch, listeners };
}

test('Safari mouse release activates once even when WebKit omits click', t => {
    const h = setup(t);
    h.fire('pointerdown'); h.fire('pointerup', { shiftKey: true });
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].shiftKey, true);
    h.fire('pointerup');
    assert.equal(h.calls.length, 1, 'a second release without a new press does nothing');
    h.fire('pointerdown'); h.fire('pointerup');
    assert.equal(h.calls.length, 2, 'the next gesture works even if the previous click never arrived');
});

test('a following native click is consumed after both accepted and cancelled confirmation', t => {
    for (const result of [true, false]) {
        const h = setup(t); let activations = 0;
        const guard = h.hooks.createSafariMouseActivation(h.icon, () => { activations++; return result; });
        guard.handle(h.event('pointerdown')); guard.handle(h.event('pointerup'));
        // No timer: closing a native confirmation after any duration still
        // consumes the same gesture's native click, including after Cancel.
        assert.equal(guard.consumeClick(h.event('click')), true);
        assert.equal(activations, 1);
        guard.handle(h.event('pointerdown')); guard.handle(h.event('pointerup'));
        assert.equal(activations, 2);
        assert.equal(guard.consumeClick(h.event('click')), true);
    }
});

test('keyboard, assistive, and programmatic clicks keep their normal activation path', t => {
    const h = setup(t); h.fire('pointerdown'); h.fire('pointerup');
    assert.equal(h.guard.consumeClick(h.event('click', { detail: 0 })), false);
    assert.equal(h.guard.consumeClick(h.event('click', { isTrusted: false })), false);
    h.fire('keydown', { key: 'Enter' });
    assert.equal(h.guard.consumeClick(h.event('click')), false);
});

test('only trusted primary mouse gestures receive Safari release activation', t => {
    for (const fields of [{ isTrusted: false }, { button: 1 }, { button: 2 },
        { pointerType: 'touch' }, { pointerType: 'pen' }, { isPrimary: false }]) {
        const h = setup(t); h.fire('pointerdown', fields); h.fire('pointerup', fields);
        assert.equal(h.calls.length, 0, JSON.stringify(fields));
        assert.equal(h.guard.consumeClick(h.event('click')), false);
    }
});

test('a release requires a matching press and pointer', t => {
    const h = setup(t); h.fire('pointerup');
    h.fire('pointerdown'); h.fire('pointerup', { pointerId: 2 });
    assert.equal(h.calls.length, 0);
    h.fire('pointerup'); assert.equal(h.calls.length, 1);
});

test('dragging beyond the threshold cancels activation even after returning to the icon', t => {
    const h = setup(t); h.fire('pointerdown'); h.fire('pointermove', { clientX: 29 });
    h.fire('pointermove'); h.fire('pointerup');
    assert.equal(h.calls.length, 0);
    assert.equal(h.guard.consumeClick(h.event('click')), true);
    h.fire('pointerdown'); h.fire('pointerup', { clientX: 28 });
    assert.equal(h.calls.length, 1, 'small pointer jitter is allowed');
});

test('leaving, cancelling, and losing pointer capture cancel the gesture', t => {
    for (const type of ['pointerleave', 'pointercancel', 'lostpointercapture']) {
        const h = setup(t); h.fire('pointerdown'); h.fire(type); h.fire('pointerup');
        assert.equal(h.calls.length, 0, type);
        assert.equal(h.guard.consumeClick(h.event('click')), true);
    }
});

test('disabled, detached, recycled, or released-outside buttons cannot activate', t => {
    for (const { change, outside } of [
        { change: h => { h.icon.disabled = true; } },
        { change: h => h.icon.remove() },
        { change: h => { h.icon._tmBeatportMedia.id = '456'; } },
        { outside: true },
    ]) {
        const h = setup(t); h.fire('pointerdown'); change?.(h);
        h.fire('pointerup', { target: outside ? h.w.document.body : h.icon });
        assert.equal(h.calls.length, 0);
        assert.equal(h.guard.consumeClick(h.event('click')), true);
    }
    const h = setup(t); h.icon.disabled = true; h.fire('pointerdown');
    h.icon.disabled = false; h.fire('pointerup'); assert.equal(h.calls.length, 0);
});

test('Shift pressed during an existing gesture still reaches the copy action', t => {
    const h = setup(t); h.fire('pointerdown'); h.fire('keydown', { key: 'Shift' });
    h.fire('pointerup', { shiftKey: true });
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].shiftKey, true);
});

test('real action binding copies once and preserves player event isolation', t => {
    const h = setup(t); let copied = 0;
    h.w.GM_setClipboard = url => { assert.equal(url, h.icon._tmBeatportMedia.url); copied++; };
    h.bind();
    assert.equal(h.dispatch('pointerdown').stopped, true);
    assert.equal(h.dispatch('pointerup', { shiftKey: true }).stopped, true);
    assert.equal(copied, 1);
    const click = h.dispatch('click', { shiftKey: true });
    assert.equal(click.prevented, true); assert.equal(click.stopped, true);
    assert.equal(copied, 1, 'native click must not copy or submit a second time');
});

test('real action binding keeps repeat-download confirmation and never reopens it for the native click', t => {
    const h = setup(t); let prompts = 0;
    h.w.GM_getValue = key => key === 'beatport.downloaded.v1.track:123' ? Date.now() : 0;
    h.w.confirm = () => { prompts++; return false; };
    h.bind(); h.dispatch('pointerdown'); h.dispatch('pointerup'); h.dispatch('click');
    assert.equal(prompts, 1);
    h.dispatch('pointerdown'); h.dispatch('pointerup'); h.dispatch('click');
    assert.equal(prompts, 2, 'a new gesture can ask again after cancellation');
});

for (const localOnly of [false, true]) {
    test(`accepted Safari release submits exactly once in ${localOnly ? 'local' : 'library'} mode`, async t => {
        const h = setup(t, safari27, localOnly), requests = [];
        let prompts = 0;
        h.w.GM_getValue = (key, fallback) => key === 'beatport.downloaded.v1.track:123' ? Date.now() : fallback;
        h.w.confirm = () => { prompts++; return true; };
        h.w.GM_xmlhttpRequest = request => {
            requests.push(request);
            request.onload({ status: 200, responseText: JSON.stringify({ accepted: true, jobs: [], active: false }) });
        };
        h.bind(); h.dispatch('pointerdown'); h.dispatch('pointerup');
        for (let i = 0; i < 12; i++) await Promise.resolve();
        h.dispatch('click');
        const submissions = requests.filter(request => request.method === 'POST' && request.url.endsWith('/jobs'));
        assert.equal(prompts, 1, 'the following click cannot reopen an accepted confirmation');
        assert.equal(submissions.length, 1);
        assert.deepEqual(JSON.parse(submissions[0].data), {
            urls: [h.icon._tmBeatportMedia.url], mode: localOnly ? 'local' : 'library',
        });
    });
}

test('only Safari 27 gets mouse-release activation; Chrome and other Safari versions retain click', t => {
    for (const agent of ['Mozilla/5.0 Chrome/150.0 Safari/537.36', safari27.replace('27.0', '26.0'),
        safari27.replace('27.0', '28.0'), safari27 + ' CriOS/150.0', safari27 + ' FxiOS/150.0']) {
        const h = setup(t, agent); let copies = 0; h.w.GM_setClipboard = () => copies++; h.bind();
        h.dispatch('pointerdown'); h.dispatch('pointerup', { shiftKey: true });
        assert.equal(copies, 0); assert.equal(h.listeners.has('pointermove'), false);
        h.dispatch('click', { shiftKey: true }); assert.equal(copies, 1);
    }
});
