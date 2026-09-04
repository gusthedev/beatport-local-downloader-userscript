const { JSDOM } = require('jsdom');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'beatport-local-hazel.user.js'), 'utf8');
function setup(t, storage = new Map(), legacy = false) {
 const dom = new JSDOM('<main><h1>Track</h1><article><a href="/track/test/123">Track title</a><a href="/track/test/123">Short</a></article></main><div id="clock">0</div>', {url:'https://www.beatport.com/track/test/123',runScripts:'outside-only',pretendToBeVisual:true});
 const w = dom.window, frames=[], listeners=new Map(); let sequence=0, local=false, modeListener;
 w.Range.prototype.getClientRects=()=>[];
 w.requestAnimationFrame=fn => {frames.push(fn);return frames.length;};
 w.GM_getValue=(k,d)=>storage.has(k)?storage.get(k):d;
 w.GM_setValue=(k,v)=>{storage.set(k,v);for(const {key,fn} of listeners.values()) if(key===k)fn(k,null,v,true);};
 w.GM_listValues=()=>[...storage.keys()]; w.GM_deleteValue=k=>storage.delete(k);
 if(!legacy){w.GM_addValueChangeListener=(key,fn)=>{listeners.set(++sequence,{key,fn});return sequence;};w.GM_removeValueChangeListener=id=>listeners.delete(id);}
 w.BEATPORTDL_CONFIG=legacy?{}:{get localOnly(){return local;},setLocalOnly(v){local=v;modeListener?.();},onModeChange(fn){modeListener=fn;}};
 w.__TM_BEATPORTDL_TEST_MODE__={}; w.eval(source);
 const hooks=w.__TM_BEATPORTDL_TEST_HOOKS__;
 t.after(()=>{hooks.instance.observer.disconnect();w.close();});
 return {w,hooks,listeners,storage, async settle(){for(let i=0;i<12;i++){await Promise.resolve();frames.splice(0).forEach(fn=>fn());}assert.equal(frames.length,0);}};
}
test('row batching places one action and releases listeners for removed media',async t=>{
 const h=setup(t);await h.settle();
 assert.equal(h.w.document.querySelectorAll('article button').length,1);
 assert.equal(h.listeners.size,1);
 h.w.document.querySelector('article').remove();h.w.history.pushState({},'', '/genre/house/5');h.w.document.querySelector('h1').remove();await h.settle();
 assert.equal(h.listeners.size,0);
});
test('submission state survives navigation and receives cross-tab updates; expiry is pruned',async t=>{
 const h=setup(t);await h.settle();const key='beatport.submitted.v1.track:123';
 h.w.GM_setValue(key,Date.now());
 assert.equal(h.w.document.querySelector('article button').textContent,'✓');
 assert.ok(h.hooks.submissionTime({type:'track',id:'123'}));
 const second=setup(t,h.storage);await second.settle();assert.equal(second.w.document.querySelector('article button').textContent,'✓');
 h.storage.set(key,Date.now()-86400001);h.hooks.pruneSubmissionStorage();h.w.dispatchEvent(new h.w.Event('focus'));
 assert.equal(h.storage.has(key),false);assert.equal(h.w.document.querySelector('article button').textContent,'⇩');
});
test('visible mode control follows clicks and loader updates; legacy loaders remain usable',async t=>{
 const h=setup(t);await h.settle();const mode=h.w.document.getElementById('tm-beatportdl-mode');
 assert.match(mode.textContent,/Normal library/);mode.click();assert.match(mode.textContent,/Local only/);
 h.w.BEATPORTDL_CONFIG.setLocalOnly(false);assert.match(mode.textContent,/Normal library/);
 const old=setup(t,new Map(),true);await old.settle();assert.equal(old.w.document.getElementById('tm-beatportdl-mode'),null);assert.equal(old.w.document.querySelectorAll('article button').length,1);
});
test('unrelated player changes do not reconcile the title control',async t=>{
 const h=setup(t);await h.settle();let headingQueries=0;const q=h.w.document.querySelector.bind(h.w.document);
 h.w.document.querySelector=s=>{if(s.includes('h1'))headingQueries++;return q(s);};
 q('#clock').firstChild.data='1';await h.settle();assert.equal(headingQueries,0);
});
test('recent submissions require confirmation while Shift-click still copies without a job',async t=>{
 const h=setup(t);await h.settle();let confirms=0,clickedDownloads=0,copied='';
 h.w.confirm=()=>{confirms++;return false;};h.w.GM_setClipboard=value=>{copied=value;};
 h.w.HTMLAnchorElement.prototype.click=function(){clickedDownloads++;};
 h.w.GM_setValue('beatport.submitted.v1.track:123',Date.now());
 const button=h.w.document.querySelector('article button');button.click();
 assert.equal(confirms,1);assert.equal(clickedDownloads,0);
 button.dispatchEvent(new h.w.MouseEvent('click',{bubbles:true,shiftKey:true}));
 assert.equal(confirms,1);assert.equal(clickedDownloads,0);assert.equal(copied,'https://www.beatport.com/track/test/123');
});
