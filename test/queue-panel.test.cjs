const { JSDOM } = require('jsdom');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'beatport-local-hazel.user.js'), 'utf8');
const SEEN_KEY = 'beatportLoader.queueErrorsSeen.v1';
const ALERTS_SINCE_KEY = 'beatportLoader.queueErrorAlertsSince.v1';

// Separate JS realms share serialized GM storage. Notifications are queued so
// tests can overlap writes and deliver remote changes after a tab becomes stale.
function sharedStorage(initial = {}) {
    const values = new Map(Object.entries(initial)), listeners = new Map(), pending = [], writes = [];
    let nextId = 1;
    const copy = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
    return {
        writes,
        get: key => copy(values.get(key)),
        attach(w) {
            let staleSeen;
            w.GM_getValue = (key, fallback) => {
                if (key === SEEN_KEY && staleSeen !== undefined) {
                    const value = staleSeen; staleSeen = undefined; return copy(value);
                }
                return copy(values.has(key) ? values.get(key) : fallback);
            };
            w.GM_setValue = (key, value) => {
                const oldValue = copy(values.get(key)), newValue = copy(value);
                values.set(key, newValue); writes.push({key, value:newValue});
                for (const [id, listener] of listeners) {
                    if (listener.key === key) pending.push({id, key, oldValue, newValue, remote:listener.w !== w});
                }
            };
            w.GM_addValueChangeListener = (key, fn) => {
                const id = nextId++; listeners.set(id, {key, fn, w}); return id;
            };
            w.GM_removeValueChangeListener = id => listeners.delete(id);
            return {
                // Model two read/modify/write operations reading the same value.
                staleSeenRead(value) { staleSeen = copy(value); },
                detach() { for (const [id, listener] of listeners) if (listener.w === w) listeners.delete(id); },
            };
        },
        flush({reverse = false} = {}) {
            let delivered = 0;
            while (pending.length) {
                assert(++delivered < 1000, 'storage listeners must converge without an echo loop');
                const event = reverse ? pending.pop() : pending.shift();
                listeners.get(event.id)?.fn(event.key, copy(event.oldValue), copy(event.newValue), event.remote);
            }
        },
    };
}

function setup(t, storage = sharedStorage()) {
    const dom = new JSDOM('<main><h1>Track</h1><article><a href="/track/example/123">Example</a></article><button id="player">Play</button></main>',
        { url:'https://www.beatport.com/track/example/123',runScripts:'outside-only',pretendToBeVisual:true });
    const w = dom.window, requests = [], downloads = [];
    let shadow, local = false, modeChange, snapshot = {jobs:[],active:false,paused:false,venus:false};
    const attach = w.Element.prototype.attachShadow;
    w.Element.prototype.attachShadow = function(options) { shadow = attach.call(this, options); return shadow; };
    w.Range.prototype.getClientRects = () => [];
    w.URL.createObjectURL = () => 'blob:fixture';
    w.URL.revokeObjectURL = () => {};
    w.HTMLAnchorElement.prototype.click = function() { downloads.push({href:this.href,download:this.download}); };
    w.BEATPORTDL_CONFIG = {helperEnabled:true,getHelperToken:()=> 'a'.repeat(64),setHelperToken(){},
        get localOnly(){return local;},setLocalOnly(value){local=value;modeChange?.();},onModeChange(fn){modeChange=fn;}};
    w.GM_xmlhttpRequest = request => { requests.push(request);request.onload({status:200,responseText:JSON.stringify(request.url.endsWith('/jobs')&&request.method==='GET'?snapshot:{accepted:true})}); };
    const storageTab = storage.attach(w);
    w.__TM_BEATPORTDL_TEST_MODE__ = {};
    w.eval(source);
    t.after(()=>{storageTab.detach();w.__TM_BEATPORTDL_TEST_HOOKS__.instance.observer.disconnect();w.close();});
    return {w,shadow,requests,downloads,storageTab,setSnapshot(value){snapshot={...snapshot,...value};},async settle(){for(let i=0;i<12;i++)await Promise.resolve();}};
}

test('manual retry controls require confirmation for all failures and offer transfer-only retry', async t => {
    const h=setup(t);
    h.setSnapshot({retryable_count:2,jobs:[{id:'a',title:'Prepared',state:'waiting_venus',mode:'library',label:'Transfer needs attention',error:'fixture'}]});
    h.shadow.querySelector('[data-toggle]').click();await h.settle();
    const retryAll=h.shadow.querySelector('[data-retry-failed]');
    assert.equal(retryAll.hidden,false);assert.match(retryAll.textContent,/2/);
    h.w.confirm=()=>false;retryAll.click();await h.settle();
    assert(!h.requests.some(r=>r.url.endsWith('/retry-failed')));
    let prompt='';h.w.confirm=message=>{prompt=message;return true;};retryAll.click();await h.settle();
    assert.match(prompt,/older failures/);assert.match(prompt,/saved stage/);
    assert(h.requests.some(r=>r.url.endsWith('/retry-failed')));
    const retry=h.shadow.querySelector('[data-jobs] button');assert.equal(retry.textContent,'Retry transfer');
    retry.click();await h.settle();
    assert(h.requests.some(r=>r.url.endsWith('/retry')&&JSON.parse(r.data).id==='a'));
});

test('new failures turn the collapsed button red until History is reviewed', async t => {
    const h=setup(t),button=h.shadow.querySelector('[data-toggle]');
    const updated=Date.now()/1000+1;
    h.setSnapshot({jobs:[{id:'a',title:'New failure',state:'failed',mode:'local',label:'Needs attention',updated,error:'fixture'}]});
    button.click();await h.settle();h.shadow.querySelector('[data-close]').click();
    assert.equal(button.classList.contains('needs-attention'),true);assert.match(button.textContent,/1 to check/);
    button.click();await h.settle();
    const history=h.shadow.querySelector('[data-history]');history.open=true;history.dispatchEvent(new h.w.Event('toggle'));
    h.shadow.querySelector('[data-close]').click();
    assert.equal(button.classList.contains('needs-attention'),false);
    // A genuinely new failure on the same job must notify again after retry.
    h.setSnapshot({jobs:[{id:'a',title:'Failed again',state:'failed',updated:updated+1,error:'fixture'}]});
    button.click();history.open=false;await h.settle();h.shadow.querySelector('[data-close]').click();
    assert.equal(button.classList.contains('needs-attention'),true);
});

const failure = (id, updated) => ({id, updated, title:id, state:'failed', error:'fixture'});
async function showFailures(h, jobs) {
    h.setSnapshot({jobs});
    h.shadow.querySelector('[data-toggle]').click();
    await h.settle();
}
function reviewHistory(h) {
    const history = h.shadow.querySelector('[data-history]');
    history.open = true;
    history.dispatchEvent(new h.w.Event('toggle'));
}

test('remote History review clears collapsed attention without polling or waking the helper', async t => {
    const storage = sharedStorage({[ALERTS_SINCE_KEY]:50});
    const a = setup(t, storage), b = setup(t, storage);
    await showFailures(a, [failure('a', 100)]);
    await showFailures(b, [failure('a', 100)]);
    const button = b.shadow.querySelector('[data-toggle]');
    b.shadow.querySelector('[data-close]').click();
    assert.equal(button.classList.contains('needs-attention'), true);
    assert.match(button.textContent, /1 to check/);
    assert.equal(storage.get(SEEN_KEY), undefined, 'opening the panel alone does not review failed History');
    const requests = [a.requests.length, b.requests.length];
    reviewHistory(a); storage.flush();
    assert.equal(button.classList.contains('needs-attention'), false);
    assert.equal(button.textContent, 'Downloads');
    assert.equal(button.title, 'Open download queue');
    assert.equal(b.shadow.querySelector('[data-panel]').hidden, true);
    assert.equal(b.shadow.querySelector('[data-history]').open, false);
    assert.deepEqual([a.requests.length, b.requests.length], requests);
    assert([...a.requests, ...b.requests].every(r => r.method === 'GET'));
    assert.equal(a.downloads.length + b.downloads.length, 0);
    assert.equal(storage.writes.filter(write => write.key === SEEN_KEY).length, 1, 'no echo writes for equal state');
});

test('a stale tab reads and merges stored acknowledgments before reviewing another failure', async t => {
    const storage = sharedStorage({[ALERTS_SINCE_KEY]:50});
    const a = setup(t, storage), b = setup(t, storage);
    await showFailures(a, [failure('a', 100)]);
    await showFailures(b, [failure('b', 101)]);
    reviewHistory(a);
    // B has received no value-change notification yet.
    reviewHistory(b);
    assert.deepEqual(storage.get(SEEN_KEY), {a:100, b:101});
    storage.flush();
    assert.deepEqual(storage.get(SEEN_KEY), {a:100, b:101});
});

for (const reverse of [false, true]) {
    test(`concurrent acknowledgments converge with ${reverse ? 'reversed' : 'ordered'} notifications`, async t => {
        const storage = sharedStorage({[ALERTS_SINCE_KEY]:50});
        const a = setup(t, storage), b = setup(t, storage);
        await showFailures(a, [failure('a', 100), failure('same', 110)]);
        await showFailures(b, [failure('b', 101), failure('same', 105)]);
        a.storageTab.staleSeenRead({}); reviewHistory(a);
        b.storageTab.staleSeenRead({}); reviewHistory(b);
        assert.deepEqual(storage.get(SEEN_KEY), {b:101, same:105}, 'both writes started from the same old value');
        storage.flush({reverse});
        assert.deepEqual(storage.get(SEEN_KEY), {a:100, b:101, same:110});
        for (const h of [a, b]) {
            h.shadow.querySelector('[data-close]').click();
            assert.equal(h.shadow.querySelector('[data-toggle]').classList.contains('needs-attention'), false);
            assert.equal(h.shadow.querySelector('[data-toggle]').textContent, 'Downloads');
        }
        storage.flush({reverse});
        const writes = storage.writes.length;
        storage.flush();
        assert.equal(storage.writes.length, writes);
        assert(storage.writes.filter(write => write.key === SEEN_KEY).length <= 4, 'repair converges in a bounded number of writes');
    });
}

test('a new failure after retry needs a new review and an older tab cannot lower its acknowledgment', async t => {
    const storage = sharedStorage({[ALERTS_SINCE_KEY]:50});
    const a = setup(t, storage), b = setup(t, storage);
    await showFailures(a, [failure('same', 100)]);
    await showFailures(b, [failure('same', 100)]);
    b.shadow.querySelector('[data-close]').click();
    reviewHistory(a); storage.flush();
    a.setSnapshot({jobs:[{id:'same', title:'Retrying', state:'queued'}], paused:true});
    a.shadow.querySelector('[data-history-jobs] button').click(); await a.settle();
    assert(a.requests.some(r => r.method === 'POST' && r.url.endsWith('/retry')));
    a.shadow.querySelector('[data-history]').open = false;
    a.shadow.querySelector('[data-close]').click();
    await showFailures(a, [failure('same', 120)]);
    a.shadow.querySelector('[data-close]').click();
    const button = a.shadow.querySelector('[data-toggle]');
    assert.equal(button.classList.contains('needs-attention'), true);
    assert.match(button.textContent, /1 to check/);
    assert.deepEqual(storage.get(SEEN_KEY), {same:100});
    button.click(); await a.settle(); reviewHistory(a); storage.flush();
    assert.deepEqual(storage.get(SEEN_KEY), {same:120});
    // B still has the pre-retry failure snapshot, but reviewing it must not
    // downgrade the watermark or make that older failure look unseen again.
    b.shadow.querySelector('[data-toggle]').click(); await b.settle(); reviewHistory(b);
    b.shadow.querySelector('[data-close]').click(); storage.flush();
    assert.deepEqual(storage.get(SEEN_KEY), {same:120});
    assert.equal(b.shadow.querySelector('[data-toggle]').classList.contains('needs-attention'), false);
});

test('concurrent merges keep the newest 200 entries with a stable tie-break at the cap', async t => {
    const initial = Object.fromEntries(Array.from({length:199}, (_, i) => ['old' + i, 100]));
    const storage = sharedStorage({[ALERTS_SINCE_KEY]:50, [SEEN_KEY]:initial});
    const a = setup(t, storage), b = setup(t, storage);
    await showFailures(a, [failure('z', 100), failure('new', 200)]);
    await showFailures(b, [failure('a', 100)]);
    a.storageTab.staleSeenRead(initial); reviewHistory(a);
    b.storageTab.staleSeenRead(initial); reviewHistory(b);
    storage.flush({reverse:true});
    const seen = storage.get(SEEN_KEY);
    assert.equal(Object.keys(seen).length, 200);
    assert.equal(seen.new, 200); assert.equal(seen.a, 100);
    assert.equal(seen.z, undefined);
    assert.equal(seen.old99, undefined);
    assert(storage.writes.filter(write => write.key === SEEN_KEY).every(write => Object.keys(write.value).length <= 200));
    const c = setup(t, storage);
    await showFailures(c, [failure('new', 200), failure('a', 100)]);
    c.shadow.querySelector('[data-close]').click();
    assert.equal(c.shadow.querySelector('[data-toggle]').classList.contains('needs-attention'), false);
});

test('remote acknowledgment preserves historical suppression and transfer review semantics', async t => {
    const storage = sharedStorage({[ALERTS_SINCE_KEY]:50});
    const a = setup(t, storage), b = setup(t, storage);
    const jobs = [failure('historical', 1), failure('failed', 100),
        {...failure('transfer', 101), state:'waiting_venus'}];
    await showFailures(b, jobs);
    // The visible current transfer is reviewed without expanding History.
    assert.deepEqual(storage.get(SEEN_KEY), {transfer:101});
    b.shadow.querySelector('[data-close]').click();
    await showFailures(a, jobs); reviewHistory(a); storage.flush();
    assert.deepEqual(storage.get(SEEN_KEY), {transfer:101, failed:100});
    assert.equal(b.shadow.querySelector('[data-toggle]').textContent, 'Downloads · 1');
    assert.equal(b.shadow.querySelector('[data-toggle]').classList.contains('needs-attention'), false);
    // An expanded History inside a collapsed panel does not review new errors.
    reviewHistory(b); storage.flush();
    assert.equal(b.shadow.querySelector('[data-panel]').hidden, true);
});

for (const active of [true, false]) {
    test(`remote review leaves ${active ? 'active' : 'idle'} polling timers unchanged`, async t => {
        const storage = sharedStorage({[ALERTS_SINCE_KEY]:50});
        const a = setup(t, storage), b = setup(t, storage);
        await Promise.all([a.settle(), b.settle()]);
        const timerCalls = [];
        b.w.setTimeout = (fn, delay) => { timerCalls.push(['set', delay]); return timerCalls.length; };
        b.w.clearTimeout = id => timerCalls.push(['clear', id]);
        b.setSnapshot({active, idle_remaining:active ? null : 180});
        await showFailures(b, [failure('a', 100)]);
        assert.deepEqual(timerCalls.filter(([kind]) => kind === 'set').map(([, delay]) => delay), active ? [1500] : [1000, 10000]);
        const before = [...timerCalls], requests = b.requests.length;
        await showFailures(a, [failure('a', 100)]); reviewHistory(a); storage.flush();
        assert.deepEqual(timerCalls, before);
        assert.equal(b.requests.length, requests);
        assert.equal(b.downloads.length, 0);
        assert.equal(b.shadow.querySelector('[data-toggle]').textContent, 'Downloads');
    });
}

test('duplicate jobs appear in History without retry or error attention', async t => {
    const h=setup(t);h.setSnapshot({retryable_count:0,jobs:[{id:'a',title:'Existing track',state:'completed',label:'Duplicate',detail:'Existing file kept',updated:Date.now()/1000+1}]});
    h.shadow.querySelector('[data-toggle]').click();await h.settle();
    assert.match(h.shadow.querySelector('[data-history-jobs]').textContent,/Duplicate/);
    assert.equal(h.shadow.querySelector('[data-history-jobs] button'),null);
    assert.equal(h.shadow.querySelector('[data-retry-failed]').hidden,true);
    h.shadow.querySelector('[data-close]').click();
    assert.equal(h.shadow.querySelector('[data-toggle]').classList.contains('needs-attention'),false);
});

test('completed rows combine count and destination into one delivery line', async t => {
    const h=setup(t);h.setSnapshot({jobs:[
        {id:'a',title:'Single',mode:'library',state:'completed',label:'Delivered to Venus',files:1,complete:1},
        {id:'b',title:'Batch',mode:'local',state:'completed',label:'Saved locally',files:3,complete:3}]});
    h.shadow.querySelector('[data-toggle]').click();await h.settle();
    const rows=h.shadow.querySelectorAll('[data-history-jobs] article');
    assert.equal(rows[0].querySelector('small').hidden,true);
    assert.match(rows[0].textContent,/1\/1 file delivered to Venus/);
    assert.equal(rows[1].querySelector('small').hidden,true);
    assert.match(rows[1].textContent,/3\/3 files delivered locally/);
});

test('history offers independent completed and failed clearing', async t => {
    const h=setup(t);h.setSnapshot({completed_history_count:2,failed_history_count:1});
    h.shadow.querySelector('[data-toggle]').click();await h.settle();
    assert.equal(h.shadow.querySelector('[data-clear-completed]').hidden,false);
    assert.equal(h.shadow.querySelector('[data-clear-failed]').hidden,false);
    h.w.confirm=()=>true;h.shadow.querySelector('[data-clear-failed]').click();await h.settle();
    assert(h.requests.some(r=>r.url.endsWith('/history/clear-failed')));
    assert(!h.requests.some(r=>r.url.endsWith('/history/clear-completed')));
});

test('idle countdown displays minutes and seconds without sending keepalive requests', async t => {
    const h=setup(t);h.setSnapshot({idle_remaining:272});
    h.shadow.querySelector('[data-toggle]').click();await h.settle();
    assert.equal(h.shadow.querySelector('[data-sleep]').textContent,'Helper sleeps in 4:32');
    assert.equal(h.requests.filter(r=>r.method==='POST').length,0);
    h.setSnapshot({active:true,idle_remaining:null});
    h.shadow.querySelector('[data-close]').click();h.shadow.querySelector('[data-toggle]').click();await h.settle();
    assert.match(h.shadow.querySelector('[data-sleep]').textContent,/stays awake while working/);
});

test('Start reconnect resumes pending work without retrying failed downloads', async t => {
    const h=setup(t);h.shadow.querySelector('[data-wake]').click();await h.settle();
    assert(h.requests.some(r=>r.method==='POST'&&r.url.endsWith('/resume')));
    assert(!h.requests.some(r=>r.url.endsWith('/retry-failed')));
});

test('queue starts collapsed, has no backdrop and stays above the player area', async t => {
    const h=setup(t),host=h.w.document.getElementById('tm-beatportdl-queue');
    assert.equal(h.shadow.querySelector('[data-panel]').hidden,true);
    assert.equal(host.style.pointerEvents,'none');assert.equal(host.style.top,'88px');
    assert.match(h.shadow.querySelector('style').textContent,/100dvh - 250px/);
    assert.equal(h.w.document.getElementById('tm-beatportdl-mode'),null);
    h.shadow.querySelector('[data-toggle]').click();await h.settle();
    assert.equal(h.shadow.querySelector('[data-panel]').hidden,false);
    h.w.document.getElementById('player').dispatchEvent(new h.w.Event('pointerdown',{bubbles:true,composed:true}));
    assert.equal(h.shadow.querySelector('[data-panel]').hidden,true);
});

test('panel can move sides and never intercepts keyboard playback outside it', t => {
    const h=setup(t),host=h.w.document.getElementById('tm-beatportdl-queue');
    h.shadow.querySelector('[data-side]').click();assert.equal(host.style.left,'8px');
    let keys=0;h.w.addEventListener('keydown',()=>keys++);
    h.shadow.querySelector('[data-links]').dispatchEvent(new h.w.KeyboardEvent('keydown',{key:' ',bubbles:true,composed:true}));
    assert.equal(keys,0);
    h.w.document.getElementById('player').dispatchEvent(new h.w.KeyboardEvent('keydown',{key:' ',bubbles:true}));
    assert.equal(keys,1);
});

test('direct jobs keep per-click mode and never generate TXT files', async t => {
    const h=setup(t);h.shadow.querySelector('[data-toggle]').click();await h.settle();
    h.w.BEATPORTDL_CONFIG.setLocalOnly(true);
    h.w.document.querySelector('article button').click();await h.settle();
    const post=h.requests.find(r=>r.method==='POST');assert(post);
    assert.equal(JSON.parse(post.data).mode,'local');assert.equal(JSON.parse(post.data).urls[0],'https://www.beatport.com/track/example/123');
    assert.equal(post.headers.Authorization,'Bearer '+'a'.repeat(64));assert.equal(h.downloads.length,0);
});

test('untrusted job titles are text and successful delivery does not claim Music import', async t => {
    const h=setup(t);h.setSnapshot({jobs:[{id:'a'.repeat(32),title:'<img src=x onerror=alert(1)>',state:'completed',mode:'library',label:'Delivered to Venus',files:1,complete:1}]});
    h.shadow.querySelector('[data-toggle]').click();await h.settle();
    assert.equal(h.shadow.querySelector('img'),null);assert.match(h.shadow.textContent,/1\/1 file delivered to Venus/);
    assert.doesNotMatch(h.shadow.textContent,/Apple Music importing|handled remotely by the Mac mini/);
});

test('failed submission never silently falls back to Hazel text files', async t => {
    const h=setup(t);h.shadow.querySelector('[data-toggle]').click();await h.settle();
    h.w.GM_xmlhttpRequest=request=>request.onload({status:403,responseText:'{"error":"Helper pairing required."}'});
    h.w.document.querySelector('article button').click();await h.settle();
    assert.equal(h.downloads.length,0);assert.match(h.shadow.querySelector('[data-message]').textContent,/pairing required/);
});

test('an awake helper never needs a wake file even after reconnecting', async t => {
    const h=setup(t);await h.settle();
    h.shadow.querySelector('[data-wake]').click();await h.settle();
    h.shadow.querySelector('[data-wake]').click();await h.settle();
    assert.equal(h.downloads.length,0);
});

test('historical failures stay collapsed, capped at ten, and do not set an error badge', async t => {
    const h=setup(t);
    h.setSnapshot({history_count:1000,jobs:Array.from({length:30},(_,i)=>({id:String(i),title:'Old track '+i,state:'failed',mode:'local',label:'Needs attention',updated:1,error:'Old failure'}))});
    h.shadow.querySelector('[data-toggle]').click();await h.settle();
    assert.equal(h.shadow.querySelector('[data-history]').open,false);
    assert.equal(h.shadow.querySelector('[data-history-jobs]').children.length,10);
    assert.match(h.shadow.querySelector('[data-history-title]').textContent,/latest 10 of 1000/);
    assert.equal(h.shadow.querySelector('[data-toggle]').textContent,'Downloads');
    assert.equal(h.shadow.querySelector('[data-jobs]').textContent,'No current downloads.');
});

test('current jobs remain separate and clear history preserves logs without an undo control', async t => {
    const h=setup(t);h.setSnapshot({jobs:[{id:'a',title:'Current',state:'processing',mode:'library',label:'Converting'},
        {id:'b',title:'Old',state:'completed',mode:'local',label:'Saved locally'}]});
    h.shadow.querySelector('[data-toggle]').click();await h.settle();
    assert.equal(h.shadow.querySelector('[data-jobs]').children.length,1);
    assert.equal(h.shadow.querySelector('[data-toggle]').textContent,'Downloads · 1');
    h.w.confirm=()=>false;h.shadow.querySelector('[data-clear-completed]').click();await h.settle();
    assert.equal(h.requests.filter(r=>r.method==='POST').length,0);
    let prompt='';h.w.confirm=message=>{prompt=message;return true;};h.shadow.querySelector('[data-clear-completed]').click();await h.settle();
    assert(h.requests.some(r=>r.url.endsWith('/history/clear-completed')));
    assert.match(prompt,/retry log will be kept/);assert.doesNotMatch(prompt,/undo/i);
    assert.equal(h.shadow.querySelector('[data-restore-history]'),null);
    assert.doesNotMatch(h.shadow.textContent,/Undo clear/);
});

test('Venus status button is disabled when connected and connects when disconnected', async t => {
    const h=setup(t);
    h.setSnapshot({venus:true,note:'Venus connected'});
    h.shadow.querySelector('[data-toggle]').click();await h.settle();
    assert.equal(h.shadow.querySelector('[data-venus]').hidden,true);
    const status=h.shadow.querySelector('[data-connect]');
    assert.equal(status.hidden,false);assert.equal(status.disabled,true);
    assert.equal(status.textContent,'Venus Connected');
    assert.doesNotMatch(h.shadow.querySelector('[data-message]').textContent,/Venus connected/);
    const requests=h.requests.length;status.click();await h.settle();assert.equal(h.requests.length,requests);
    h.setSnapshot({venus:false,note:''});h.shadow.querySelector('[data-toggle]').click();h.shadow.querySelector('[data-toggle]').click();await h.settle();
    assert.equal(status.disabled,false);assert.equal(status.textContent,'Venus Disconnected');
    assert.equal(h.shadow.querySelector('[data-venus]').hidden,false);
    status.click();await h.settle();assert(h.requests.some(r=>r.method==='POST'&&r.url.endsWith('/connect')));
});

test('paired browser has clear connection status and no prominent setup prompt', async t => {
    const h=setup(t);await h.settle();
    assert.equal(h.shadow.querySelector('[data-pairing-status]').textContent,'Connected to local helper');
    assert.equal(h.shadow.querySelector('[data-auto-pair]').hidden,true);
    assert.equal(h.shadow.querySelector('[data-pair]').open,false);
});

test('automatic pairing needs no key and targets the requesting browser with one wake file', async t => {
    const h=setup(t);await h.settle();h.w.BEATPORTDL_CONFIG.getHelperToken=()=>'';
    Object.defineProperty(h.w.navigator,'userAgent',{value:'Mozilla/5.0 Chrome/150.0 Safari/537.36'});
    h.shadow.querySelector('[data-wake]').click();await h.settle();
    assert.equal(h.shadow.querySelector('[data-auto-pair]').hidden,false);
    h.shadow.querySelector('[data-auto-pair]').click();h.shadow.querySelector('[data-auto-pair]').click();
    assert.equal(h.downloads.length,1);
    assert.match(h.downloads[0].download,/^beatportdl-wake-pair-chrome-\d+\.txt$/);
    assert.match(h.shadow.querySelector('[data-message]').textContent,/Approve Update in Tampermonkey/);
    assert.match(h.shadow.querySelector('[data-message]').textContent,/resetting settings, cancel/);
    assert.equal(h.requests.filter(r=>r.method==='POST').length,0);
});

test('Safari pairing uses Safari and a rejected key shows a repair action', async t => {
    const h=setup(t);await h.settle();
    Object.defineProperty(h.w.navigator,'userAgent',{value:'Mozilla/5.0 Version/27.0 Safari/605.1.15'});
    h.w.GM_xmlhttpRequest=request=>request.onload({status:403,responseText:'{"error":"Helper pairing required."}'});
    h.shadow.querySelector('[data-toggle]').click();await h.settle();
    assert.equal(h.shadow.querySelector('[data-auto-pair]').hidden,false);
    assert.match(h.shadow.querySelector('[data-pairing-status]').textContent,/needs repair/);
    h.shadow.querySelector('[data-auto-pair]').click();
    assert.match(h.downloads[0].download,/^beatportdl-wake-pair-safari-/);
});

test('a browser-origin rejection is not mislabeled as broken pairing', async t => {
    const h=setup(t);await h.settle();
    h.w.GM_xmlhttpRequest=request=>request.onload(request.method==='POST'
        ? {status:403,responseText:JSON.stringify({code:'origin_rejected',error:'Browser request origin rejected; the pairing key is valid.'})}
        : {status:200,responseText:'{"ok":true}'});
    h.shadow.querySelector('[data-connect]').click();await h.settle();
    assert.match(h.shadow.querySelector('[data-message]').textContent,/pairing key is valid/);
    assert.equal(h.shadow.querySelector('[data-auto-pair]').hidden,true);
    assert.doesNotMatch(h.shadow.querySelector('[data-pairing-status]').textContent,/needs repair/);
});

// Control only window timers; lifecycle tests never wait on wall-clock polling.
function queueClock(h) {
    let nextId = 1;
    const timers = new Map();
    h.w.setTimeout = (fn, delay) => { const id = nextId++; timers.set(id, {fn, delay}); return id; };
    h.w.clearTimeout = id => timers.delete(id);
    return {
        delays: () => [...timers.values()].map(timer => timer.delay),
        async tick(delay) {
            const entry = [...timers].find(([, timer]) => timer.delay === delay);
            assert(entry, `expected a ${delay}ms timer`);
            timers.delete(entry[0]); entry[1].fn(); await h.settle();
        },
    };
}

function failQueueRequests(h, kind = 'network') {
    const respond = h.w.GM_xmlhttpRequest;
    h.w.GM_xmlhttpRequest = request => {
        h.requests.push(request);
        if (kind === 'timeout') request.ontimeout();
        else if (kind === 'http') request.onload({status:503, responseText:'{"error":"Temporarily unavailable"}'});
        else request.onerror();
    };
    return () => { h.w.GM_xmlhttpRequest = respond; };
}

function assertQueueReadsOnly(h) {
    assert(h.requests.every(request => request.method === 'GET' && request.url.endsWith('/jobs')));
    assert.equal(h.downloads.length, 0, 'observation must never create a Hazel wake file');
}

for (const kind of ['network', 'timeout', 'http']) {
    test(`transient ${kind} failure recovers collapsed active observation and later failure attention`, async t => {
        const h = setup(t); await h.settle(); const clock = queueClock(h);
        const button = h.shadow.querySelector('[data-toggle]');
        // Unpaused queued work also warrants recovery without snapshot.active.
        h.setSnapshot({active:kind !== 'http', jobs:[{id:'work', state:kind === 'http' ? 'queued' : 'downloading', title:'Track'}]});
        button.click(); await h.settle(); h.shadow.querySelector('[data-close]').click();
        const recover = failQueueRequests(h, kind), before = h.requests.length;
        await clock.tick(1500);
        assert.equal(h.requests.length, before + 1);
        assert.deepEqual(clock.delays(), [1500], 'active observation must survive a failed GET');
        assert.equal(button.classList.contains('needs-attention'), false, 'a transport failure is not a failed download');

        recover(); await clock.tick(1500);
        assert.equal(h.requests.length, before + 2);
        assert.deepEqual(clock.delays(), [1500]);
        h.setSnapshot({active:false, idle_remaining:180, jobs:[failure('work', Date.now()/1000 + 1)]});
        await clock.tick(1500);
        assert.equal(h.shadow.querySelector('[data-panel]').hidden, true);
        assert.equal(button.classList.contains('needs-attention'), true);
        assert.match(button.textContent, /1 to check/);
        assert.deepEqual(clock.delays(), [], 'a fresh idle snapshot ends collapsed observation');
        assertQueueReadsOnly(h);
    });
}

test('active recovery backs off, resets after success, and stops after four failed retries', async t => {
    const h = setup(t); await h.settle(); const clock = queueClock(h);
    const button = h.shadow.querySelector('[data-toggle]');
    h.setSnapshot({active:true, jobs:[{id:'work', state:'processing', title:'Track'}]});
    button.click(); await h.settle(); h.shadow.querySelector('[data-close]').click();
    const recover = failQueueRequests(h);
    await clock.tick(1500); await clock.tick(1500);
    assert.deepEqual(clock.delays(), [3000]);
    recover(); await clock.tick(3000);
    assert.deepEqual(clock.delays(), [1500]);

    const recoverAgain = failQueueRequests(h), before = h.requests.length;
    await clock.tick(1500);
    for (const delay of [1500, 3000, 6000, 12000]) {
        assert.deepEqual(clock.delays(), [delay]);
        await clock.tick(delay);
    }
    assert.equal(h.requests.length, before + 5, 'one failed poll plus four bounded retries');
    assert.deepEqual(clock.delays(), []);
    h.w.dispatchEvent(new h.w.PageTransitionEvent('pagehide', {persisted:true}));
    h.w.dispatchEvent(new h.w.PageTransitionEvent('pageshow', {persisted:true}));
    await h.settle();
    assert.equal(h.requests.length, before + 5, 'restoring a collapsed page must not replenish exhausted retries');
    recoverAgain(); button.click(); await h.settle();
    assert.deepEqual(clock.delays(), [1500], 'an explicit refresh can restart observation');
    assertQueueReadsOnly(h);
});

for (const state of ['idle', 'paused', 'waiting_venus']) {
    test(`${state} helper request failure stops observation without waking the helper`, async t => {
        const h = setup(t); await h.settle(); const clock = queueClock(h);
        h.setSnapshot({active:false, paused:state === 'paused', idle_remaining:180,
            jobs:state === 'idle' ? [] : [{id:'work', title:'Track', state:state === 'paused' ? 'queued' : state}]});
        h.shadow.querySelector('[data-toggle]').click(); await h.settle();
        assert.deepEqual(clock.delays(), [1000, 10000]);
        failQueueRequests(h); await clock.tick(10000);
        assert.deepEqual(clock.delays(), [], 'an idle deadline does not grant active-work retries');
        h.shadow.querySelector('[data-close]').click();
        const before = h.requests.length;
        h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
        await h.settle(); assert.equal(h.requests.length, before);
        assertQueueReadsOnly(h);
    });
}

test('an unavailable helper with no known active work is not retried', async t => {
    const h = setup(t); await h.settle(); const clock = queueClock(h);
    failQueueRequests(h);
    h.shadow.querySelector('[data-toggle]').click(); await h.settle();
    assert.deepEqual(clock.delays(), []);
    assertQueueReadsOnly(h);
});

test('cross-tab acknowledgment during an outage survives recovery and a later failure still alerts', async t => {
    const storage = sharedStorage({[ALERTS_SINCE_KEY]:50});
    const a = setup(t, storage), b = setup(t, storage);
    await Promise.all([a.settle(), b.settle()]);
    const clock = queueClock(b), button = b.shadow.querySelector('[data-toggle]');
    await showFailures(a, [failure('same', 120)]);
    b.setSnapshot({active:true});
    await showFailures(b, [failure('same', 100), {id:'work', title:'Track', state:'downloading'}]);
    b.shadow.querySelector('[data-close]').click();
    const recover = failQueueRequests(b);
    await clock.tick(1500);
    const before = b.requests.length;
    reviewHistory(a); storage.flush();
    assert.equal(b.requests.length, before, 'remote review must not initiate a request');
    assert.deepEqual(clock.delays(), [1500]);
    recover(); await clock.tick(1500);
    assert.equal(button.classList.contains('needs-attention'), false);
    assert.deepEqual(storage.get(SEEN_KEY), {same:120});
    b.setSnapshot({active:false, jobs:[failure('same', 130)]});
    await clock.tick(1500);
    assert.equal(button.classList.contains('needs-attention'), true);
    assert.deepEqual(storage.get(SEEN_KEY), {same:120});
    assert.deepEqual(clock.delays(), []);
    assertQueueReadsOnly(a); assertQueueReadsOnly(b);
});

for (const lifecycle of ['visibility', 'bfcache']) {
    function suspend(h) {
        if (lifecycle === 'visibility') {
            Object.defineProperty(h.w.document, 'hidden', {configurable:true, value:true});
            h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
        } else h.w.dispatchEvent(new h.w.PageTransitionEvent('pagehide', {persisted:true}));
    }
    function restore(h) {
        if (lifecycle === 'visibility') {
            Object.defineProperty(h.w.document, 'hidden', {configurable:true, value:false});
            h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
        } else h.w.dispatchEvent(new h.w.PageTransitionEvent('pageshow', {persisted:true}));
    }

    test(`${lifecycle}: pending retries suspend and restoration preserves their bounded budget`, async t => {
        const h = setup(t); await h.settle(); const clock = queueClock(h);
        h.setSnapshot({active:true, jobs:[{id:'work', state:'downloading', title:'Track'}]});
        h.shadow.querySelector('[data-toggle]').click(); await h.settle();
        h.shadow.querySelector('[data-close]').click();
        failQueueRequests(h);
        await clock.tick(1500); await clock.tick(1500);
        assert.deepEqual(clock.delays(), [3000]);
        const before = h.requests.length;
        suspend(h); await h.settle();
        assert.deepEqual(clock.delays(), []);
        assert.equal(h.requests.length, before);
        restore(h); await h.settle();
        assert.equal(h.requests.length, before + 1);
        assert.deepEqual(clock.delays(), [6000], 'restoration must not reset the retry budget');
        await clock.tick(6000); await clock.tick(12000);
        assert.deepEqual(clock.delays(), []);
        const exhausted = h.requests.length;
        suspend(h); restore(h); await h.settle();
        assert.equal(h.requests.length, exhausted);
        assertQueueReadsOnly(h);
    });

    test(`${lifecycle}: remote review while suspended preserves active polling and later failure attention`, async t => {
        const storage = sharedStorage({[ALERTS_SINCE_KEY]:50});
        const a = setup(t, storage), b = setup(t, storage);
        await Promise.all([a.settle(), b.settle()]);
        const clock = queueClock(b), button = b.shadow.querySelector('[data-toggle]');
        await showFailures(a, [failure('same', 100)]);
        b.setSnapshot({active:true});
        await showFailures(b, [failure('same', 100), {id:'work', title:'Track', state:'downloading'}]);
        b.shadow.querySelector('[data-close]').click();
        assert.equal(button.classList.contains('needs-attention'), true);
        assert.deepEqual(clock.delays(), [1500]);

        suspend(b);
        const requests = b.requests.length;
        reviewHistory(a); storage.flush();
        assert.equal(button.classList.contains('needs-attention'), false);
        assert.equal(button.textContent, 'Downloads · 1');
        assert.equal(b.requests.length, requests);
        assert.deepEqual(clock.delays(), [], 'remote review must not restart suspended polling');

        restore(b); await b.settle();
        assert.equal(b.requests.length, requests + 1);
        assert.equal(b.shadow.querySelector('[data-panel]').hidden, true);
        assert.equal(button.classList.contains('needs-attention'), false);
        assert.deepEqual(clock.delays(), [1500]);
        b.setSnapshot({active:false, idle_remaining:180, jobs:[failure('same', 120)]});
        await clock.tick(1500);
        assert.equal(button.classList.contains('needs-attention'), true);
        assert.match(button.textContent, /1 to check/);
        assert.deepEqual(storage.get(SEEN_KEY), {same:100});
        assert.deepEqual(clock.delays(), []);
        assert([...a.requests, ...b.requests].every(r => r.method === 'GET' && r.url.endsWith('/jobs')));
        assert.equal(a.downloads.length + b.downloads.length, 0);
    });

    test(`${lifecycle}: delayed remote review survives an older in-flight restore response`, async t => {
        const storage = sharedStorage({[ALERTS_SINCE_KEY]:50});
        const a = setup(t, storage), b = setup(t, storage);
        await Promise.all([a.settle(), b.settle()]);
        const clock = queueClock(b), button = b.shadow.querySelector('[data-toggle]');
        await showFailures(a, [failure('same', 120)]);
        b.setSnapshot({active:true});
        await showFailures(b, [failure('same', 100)]);
        b.shadow.querySelector('[data-close]').click();
        suspend(b);
        // BFCache may defer value-change delivery until after restoration.
        reviewHistory(a);
        let pending;
        b.w.GM_xmlhttpRequest = request => { b.requests.push(request); pending = request; };
        const requests = b.requests.length;
        restore(b); await b.settle();
        assert.equal(b.requests.length, requests + 1);
        assert(pending);
        storage.flush();
        assert.equal(button.classList.contains('needs-attention'), false);
        assert.equal(b.requests.length, requests + 1, 'remote review must not issue a second GET');
        assert.deepEqual(clock.delays(), []);
        // The old response arrives while suspended again and must neither
        // regress the remote acknowledgment nor rearm either queue timer.
        suspend(b);
        const snapshot = {active:false, paused:false, idle_remaining:180, jobs:[failure('same', 100)]};
        pending.onload({status:200, responseText:JSON.stringify(snapshot)});
        await b.settle();
        assert.equal(button.classList.contains('needs-attention'), false);
        assert.deepEqual(clock.delays(), []);
        restore(b); await b.settle();
        assert.equal(b.requests.length, requests + 1, 'collapsed idle restore must stay idle');

        button.click();
        pending.onload({status:200, responseText:JSON.stringify(snapshot)});
        await b.settle(); reviewHistory(b); storage.flush({reverse:true});
        assert.deepEqual(storage.get(SEEN_KEY), {same:120}, 'reviewing stale History must not lower the watermark');
        assert.equal(storage.writes.filter(write => write.key === SEEN_KEY).length, 1);
        assert.deepEqual(clock.delays(), [1000, 10000]);
        assert([...a.requests, ...b.requests].every(r => r.method === 'GET' && r.url.endsWith('/jobs')));
        assert.equal(a.downloads.length + b.downloads.length, 0);
    });

    test(`${lifecycle}: collapsed active observation resumes and reports a later failure`, async t => {
        const h=setup(t);await h.settle();const clock=queueClock(h);
        const button=h.shadow.querySelector('[data-toggle]');
        h.setSnapshot({active:true,jobs:[{id:'a',state:'downloading',title:'Track'}]});
        button.click();await h.settle();h.shadow.querySelector('[data-close]').click();
        assert.deepEqual(clock.delays(),[1500]);
        const hiddenRequests=h.requests.length;
        suspend(h);await h.settle();
        // Main leaves this timer alive until it fires while hidden; exercise
        // that original failure path too, rather than failing only on cleanup.
        if (clock.delays().includes(1500)) await clock.tick(1500);
        assert.deepEqual(clock.delays(),[]);assert.equal(h.requests.length,hiddenRequests);
        const before=h.requests.length;
        restore(h);await h.settle();assert.equal(h.requests.length,before+1);
        assert.equal(h.shadow.querySelector('[data-panel]').hidden,true);
        assert.deepEqual(clock.delays(),[1500]);
        h.setSnapshot({active:false,idle_remaining:180,jobs:[{id:'a',state:'failed',title:'Track',error:'fixture',updated:Date.now()/1000+1}]});
        await clock.tick(1500);
        assert.equal(button.classList.contains('needs-attention'),true);
        assert.match(button.textContent,/1 to check/);
        assert.deepEqual(clock.delays(),[]);
        const stopped=h.requests.length;
        suspend(h);restore(h);await h.settle();
        assert.equal(h.requests.length,stopped);
        assert(h.requests.every(r=>r.method==='GET'));
        assert.equal(h.downloads.length,0);
    });

    test(`${lifecycle}: an in-flight response cannot rearm suspended timers`, async t => {
        const h=setup(t);await h.settle();const clock=queueClock(h);
        let pending;
        h.w.GM_xmlhttpRequest=request=>{h.requests.push(request);pending=request;};
        h.shadow.querySelector('[data-toggle]').click();
        h.shadow.querySelector('[data-close]').click();suspend(h);
        // Queued, unpaused work also counts, even without snapshot.active.
        pending.onload({status:200,responseText:JSON.stringify({active:false,paused:false,jobs:[{id:'a',state:'queued',title:'Track'}]})});
        await h.settle();assert.deepEqual(clock.delays(),[]);
        const before=h.requests.length;
        restore(h);await h.settle();assert.equal(h.requests.length,before+1);
        // Overlapping restore notifications must not duplicate an in-flight GET.
        restore(h);await h.settle();assert.equal(h.requests.length,before+1);
        pending.onload({status:200,responseText:JSON.stringify({active:false,paused:false,jobs:[{id:'a',state:'processing',title:'Track'}]})});
        await h.settle();assert.deepEqual(clock.delays(),[1500]);
        suspend(h);restore(h);suspend(h);
        pending.onerror();await h.settle();assert.deepEqual(clock.delays(),[]);
        const unavailable=h.requests.length;
        restore(h);restore(h);await h.settle();assert.equal(h.requests.length,unavailable+1);
        pending.onload({status:200,responseText:JSON.stringify({active:false,paused:false,jobs:[failure('a',Date.now()/1000+1)]})});
        await h.settle();assert.deepEqual(clock.delays(),[]);
        assert.equal(h.shadow.querySelector('[data-toggle]').classList.contains('needs-attention'),true);
        assert(h.requests.every(r=>r.method==='GET'));assert.equal(h.downloads.length,0);
    });

    test(`${lifecycle}: open idle countdown resumes at the existing cadence`, async t => {
        const h=setup(t);await h.settle();const clock=queueClock(h);
        h.setSnapshot({idle_remaining:180});
        h.shadow.querySelector('[data-toggle]').click();await h.settle();
        assert.deepEqual(clock.delays(),[1000,10000]);
        suspend(h);assert.deepEqual(clock.delays(),[]);
        restore(h);await h.settle();assert.deepEqual(clock.delays(),[1000,10000]);
        h.setSnapshot({idle_remaining:2});await clock.tick(10000);
        assert.deepEqual(clock.delays(),[1000,2250]);
        h.setSnapshot({idle_remaining:0});await clock.tick(2250);
        assert.deepEqual(clock.delays(),[]);
        assert(h.requests.every(r=>r.method==='GET'));assert.equal(h.downloads.length,0);
    });

    test(`${lifecycle}: collapsed paused work stays idle`, async t => {
        const h=setup(t);await h.settle();const clock=queueClock(h);
        h.setSnapshot({active:false,paused:true,jobs:[{id:'a',state:'queued',title:'Track'}]});
        h.shadow.querySelector('[data-toggle]').click();await h.settle();
        h.shadow.querySelector('[data-close]').click();
        const before=h.requests.length;
        suspend(h);restore(h);await h.settle();
        assert.equal(h.requests.length,before);assert.deepEqual(clock.delays(),[]);
    });
}

test('first submission checks helper health once when the initial snapshot is unavailable', async t => {
    const h = setup(t);
    await h.settle();
    h.w.GM_xmlhttpRequest = request => request.onerror();
    h.shadow.querySelector('[data-toggle]').click();
    await h.settle();
    h.w.GM_xmlhttpRequest = request => {
        h.requests.push(request);
        request.onload({ status: 200, responseText: JSON.stringify(
            request.method === 'GET' && request.url.endsWith('/jobs') ? {jobs:[], active:false} : {accepted:true}
        ) });
    };
    h.requests.length = 0;
    h.w.document.querySelector('article button').click();
    await h.settle();
    assert.equal(h.requests.filter(r => r.url.endsWith('/health')).length, 1);
    assert.equal(h.requests.filter(r => r.method === 'POST' && r.url.endsWith('/jobs')).length, 1);
    assert.equal(h.downloads.length, 0);
});
