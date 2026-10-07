const { JSDOM } = require('jsdom');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'beatport-local-hazel.user.js'), 'utf8');
function setup(t, storage = new Map(), legacy = false, {
 html = '<main><h1>Track</h1><article><a href="/track/test/123">Track title</a><a href="/track/test/123">Short</a></article></main><div id="clock">0</div>',
 url = 'https://www.beatport.com/track/test/123',
} = {}) {
 const dom = new JSDOM(html, {url,runScripts:'outside-only',pretendToBeVisual:true});
 const w = dom.window, frames=[], listeners=new Map(); let sequence=0, local=false, modeListener, storageScans=0;
 w.Range.prototype.getClientRects=()=>[];
 w.requestAnimationFrame=fn => {frames.push(fn);return frames.length;};
 w.GM_getValue=(k,d)=>storage.has(k)?storage.get(k):d;
 w.GM_setValue=(k,v)=>{storage.set(k,v);for(const {key,fn} of listeners.values()) if(key===k)fn(k,null,v,true);};
 w.GM_listValues=()=>{storageScans++;return [...storage.keys()];}; w.GM_deleteValue=k=>storage.delete(k);
 if(!legacy){w.GM_addValueChangeListener=(key,fn)=>{listeners.set(++sequence,{key,fn});return sequence;};w.GM_removeValueChangeListener=id=>listeners.delete(id);}
 w.BEATPORTDL_CONFIG=legacy?{}:{get localOnly(){return local;},setLocalOnly(v){local=v;modeListener?.();},onModeChange(fn){modeListener=fn;}};
 w.__TM_BEATPORTDL_TEST_MODE__={}; w.eval(source);
 const hooks=w.__TM_BEATPORTDL_TEST_HOOKS__;
 t.after(()=>{hooks.instance.observer.disconnect();w.close();});
 return {w,hooks,listeners,storage,get storageScans(){return storageScans;}, async settle(){for(let i=0;i<12;i++){await Promise.resolve();frames.splice(0).forEach(fn=>fn());}assert.equal(frames.length,0);}};
}

function assertDownloadLabels(button, description, name) {
 assert.ok(button, 'download control exists');
 for (const attribute of ['title', 'aria-label']) {
  const label = button.getAttribute(attribute);
  assert.ok(label, `${attribute} is present`);
  assert.match(label, /queue|request/i, `${attribute} describes the action`);
  assert.match(label, /local FLAC download/, `${attribute} describes the format and destination`);
  assert.ok(label.includes(name), `${attribute} identifies the linked item or page`);
  assert.ok(label.includes(description), `${attribute} describes the media scope`);
  assert.match(label, /Shift-click copies.*URL/, `${attribute} explains the alternate action`);
 }
}

for (const [type, pathname, description] of [
 ['track', '/track/test/123', 'track'],
 ['release', '/release/test/123', 'full release'],
 ['playlist', '/playlist/test/123', 'playlist'],
 ['chart', '/chart/test/123', 'chart'],
 ['artist', '/artist/test/123', 'artist catalog'],
 ['label', '/label/test/123', 'label catalog'],
 ['playlist', '/library/playlists/123', 'playlist'],
]) {
 test(`download labels describe link and page context for ${pathname}`, async t => {
  const h = setup(t, new Map(), false, {
   html: `<main><h1>Page <span>collection</span></h1><article><a href="${pathname}">Linked <span>selection</span></a></article></main>`,
   url: `https://www.beatport.com${pathname}`,
  });
  await h.settle();
  const buttons = [
   [h.w.document.querySelector('article button'), 'Linked selection'],
   [h.w.document.querySelector('h1 + button'), 'Page collection'],
  ];
  for (const [button, name] of buttons) {
   assert.equal(button.textContent, '⇩');
   assertDownloadLabels(button, description, name);
  }

  // Cross-tab submission updates must retain the item context in both labels.
  h.w.GM_setValue(`beatport.submitted.v1.${type}:123`, Date.now());
  await h.settle();
  for (const [button, name] of buttons) {
   assert.equal(button.textContent, '✓');
   assertDownloadLabels(button, description, name);
   for (const attribute of ['title', 'aria-label']) assert.match(button.getAttribute(attribute), /Submitted .*again/);
  }

  // Expiry/focus refresh restores the download action without losing its name.
  h.storage.set(`beatport.submitted.v1.${type}:123`, Date.now() - 90 * 86400000 - 1);
  h.w.dispatchEvent(new h.w.Event('focus'));
  await h.settle();
  for (const [button, name] of buttons) {
   assert.equal(button.textContent, '⇩');
   assertDownloadLabels(button, description, name);
   for (const attribute of ['title', 'aria-label']) assert.doesNotMatch(button.getAttribute(attribute), /Submitted/);
  }
 });
}

test('download labels follow changed link text, hrefs, and page titles during navigation', async t => {
 const h = setup(t);
 await h.settle();
 const link = h.w.document.querySelector('article a');
 const linkButton = link.nextElementSibling;
 link.textContent = 'Renamed track';
 h.w.document.querySelector('h1').textContent = 'Renamed page';
 await h.settle();
 assertDownloadLabels(linkButton, 'track', 'Renamed track');
 assertDownloadLabels(h.w.document.querySelector('h1 + button'), 'track', 'Renamed page');

 link.href = '/release/new/456';
 link.textContent = 'New linked release';
 h.w.history.pushState({}, '', '/release/new/456');
 h.w.document.querySelector('h1').textContent = 'New page release';
 await h.settle();
 assert.equal(link.nextElementSibling, linkButton, 'link control is reused');
 assertDownloadLabels(linkButton, 'full release', 'New linked release');
 assertDownloadLabels(h.w.document.querySelector('h1 + button'), 'full release', 'New page release');
});

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
 h.storage.set(key,Date.now()-90*86400000-1);h.storage.set('beatport.submissionCleanup.v1',0);h.hooks.pruneSubmissionStorage();h.w.dispatchEvent(new h.w.Event('focus'));
 assert.equal(h.storage.has(key),false);assert.equal(h.w.document.querySelector('article button').textContent,'⇩');
});
test('submission markers last exactly ninety days rather than one day',async t=>{
 const h=setup(t);await h.settle();const now=Date.now(),day=86400000,key='beatport.submitted.v1.track:123',media={type:'track',id:'123'};
 for(const age of [day,30*day,90*day-1]){h.storage.set(key,now-age);assert.equal(h.hooks.submissionTime(media,now),now-age);}
 h.storage.set(key,now-90*day);assert.equal(h.hooks.submissionTime(media,now),0);
 h.storage.set(key,now+1);assert.equal(h.hooks.submissionTime(media,now),0);
});
test('marker cleanup is shared across page loads and runs no more than once a day',async t=>{
 const h=setup(t);await h.settle();const day=86400000,last=h.storage.get('beatport.submissionCleanup.v1');
 assert.equal(h.storageScans,1);
 h.storage.set('beatport.submitted.v1.track:999',last-91*day);
 h.storage.set('beatportLoader.helperToken.v1','private-fixture');
 h.hooks.pruneSubmissionStorage(last+day-1);assert.equal(h.storageScans,1);
 assert.equal(h.hooks.submissionTime({type:'track',id:'999'},last+day-1),0);
 const second=setup(t,h.storage);await second.settle();assert.equal(second.storageScans,0);
 h.hooks.pruneSubmissionStorage(last+day);assert.equal(h.storageScans,2);
 assert.equal(h.storage.has('beatport.submitted.v1.track:999'),false);
 assert.equal(h.storage.get('beatportLoader.helperToken.v1'),'private-fixture');
 h.hooks.pruneSubmissionStorage(last+day+1);assert.equal(h.storageScans,2);
});
test('cleanup recovers when a clock change leaves its last-run timestamp in the future',async t=>{
 const now=Date.now(),storage=new Map([['beatport.submissionCleanup.v1',now+86400000],['beatport.submitted.v1.track:999',now+86400000]]);
 const h=setup(t,storage);await h.settle();assert.equal(h.storageScans,1);
 assert.equal(storage.has('beatport.submitted.v1.track:999'),false);
 assert(storage.get('beatport.submissionCleanup.v1')<=Date.now());
});
test('visible mode control follows clicks and loader updates; legacy loaders remain usable',async t=>{
 const h=setup(t);await h.settle();const mode=h.w.document.getElementById('tm-beatportdl-mode');
 assert.equal(h.w.getComputedStyle(mode).bottom,'110px');
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
 h.w.confirm=message=>{confirms++;assert.match(message,/last 90 days/);return false;};h.w.GM_setClipboard=value=>{copied=value;};
 h.w.HTMLAnchorElement.prototype.click=function(){clickedDownloads++;};
 h.w.GM_setValue('beatport.submitted.v1.track:123',Date.now());
 const button=h.w.document.querySelector('article button');button.click();
 assert.equal(confirms,1);assert.equal(clickedDownloads,0);
 button.dispatchEvent(new h.w.MouseEvent('click',{bubbles:true,shiftKey:true}));
 assert.equal(confirms,1);assert.equal(clickedDownloads,0);assert.equal(copied,'https://www.beatport.com/track/test/123');
 const status=h.w.document.getElementById('tm-beatportdl-status');
 assert.equal(status.hidden,false);
 assert.equal(h.w.getComputedStyle(status).bottom,'110px');
 assert.equal(h.w.getComputedStyle(status).bottom,h.w.getComputedStyle(h.w.document.getElementById('tm-beatportdl-mode')).bottom);
});
