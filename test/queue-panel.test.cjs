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
    assert.equal(h.shadow.querySelector('img'),null);assert.match(h.shadow.textContent,/Delivered to Venus/);
    assert.match(h.shadow.textContent,/handled remotely by the Mac mini/);
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

test('current jobs remain separate and clear history supports cancel and undo', async t => {
    const h=setup(t);h.setSnapshot({jobs:[{id:'a',title:'Current',state:'processing',mode:'library',label:'Converting'},
        {id:'b',title:'Old',state:'completed',mode:'local',label:'Saved locally'}]});
    h.shadow.querySelector('[data-toggle]').click();await h.settle();
    assert.equal(h.shadow.querySelector('[data-jobs]').children.length,1);
    assert.equal(h.shadow.querySelector('[data-toggle]').textContent,'Downloads · 1');
    h.w.confirm=()=>false;h.shadow.querySelector('[data-clear-history]').click();await h.settle();
    assert.equal(h.requests.filter(r=>r.method==='POST').length,0);
    h.w.confirm=()=>true;h.shadow.querySelector('[data-clear-history]').click();await h.settle();
    assert(h.requests.some(r=>r.url.endsWith('/history/clear')));
    h.setSnapshot({history_cleared:true,jobs:[]});h.shadow.querySelector('[data-restore-history]').click();await h.settle();
    assert(h.requests.some(r=>r.url.endsWith('/history/restore')));
    assert.equal(h.shadow.querySelector('[data-restore-history]').hidden,false);
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
