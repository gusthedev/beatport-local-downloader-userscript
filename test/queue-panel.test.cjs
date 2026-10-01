const { JSDOM } = require('jsdom');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'beatport-local-hazel.user.js'), 'utf8');

function setup(t) {
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
    w.__TM_BEATPORTDL_TEST_MODE__ = {};
    w.eval(source);
    t.after(()=>{w.__TM_BEATPORTDL_TEST_HOOKS__.instance.observer.disconnect();w.close();});
    return {w,shadow,requests,downloads,setSnapshot(value){snapshot={...snapshot,...value};},async settle(){for(let i=0;i<12;i++)await Promise.resolve();}};
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
        suspend(h);restore(h);
        pending.onerror();await h.settle();assert.deepEqual(clock.delays(),[]);
        const unavailable=h.requests.length;
        suspend(h);restore(h);await h.settle();assert.equal(h.requests.length,unavailable);
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
