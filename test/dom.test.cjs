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
   assert.equal(button.textContent, '↻');
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
 assert.equal(h.listeners.size,2);
 h.w.document.querySelector('article').remove();h.w.history.pushState({},'', '/genre/house/5');h.w.document.querySelector('h1').remove();await h.settle();
 assert.equal(h.listeners.size,0);
});
test('submission state survives navigation and receives cross-tab updates; expiry is pruned',async t=>{
 const h=setup(t);await h.settle();const key='beatport.submitted.v1.track:123';
 h.w.GM_setValue(key,Date.now());
 assert.equal(h.w.document.querySelector('article button').textContent,'↻');
 assert.ok(h.hooks.submissionTime({type:'track',id:'123'}));
 const second=setup(t,h.storage);await second.settle();assert.equal(second.w.document.querySelector('article button').textContent,'↻');
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

// Both table variants observed during Beatport's layout rollout. The player
// landmark is shared by the current variants; older Player-style builds remain
// supported. Hashed class suffixes deliberately differ from the live site.
for (const [layout, rowClass, playerAttributes, titleMarkup] of [
 ['legacy', 'Table-style__TableRow-sc-fixture row tracks-table', 'class="Player-style__Player-fixture"', 'Track <span>Original Mix</span>'],
 ['new', 'Row-style__Stylized-sc-fixture row', 'id="bp-player" data-testid="bp-player" class="Player_wrapper__fixture"', '<div data-testid="marquee-parent"><span>Track</span> <span>Original Mix</span></div>'],
]) {
 const html = `<main><div class="${rowClass}"><div class="cell"><a href="/track/test/123">${titleMarkup}</a></div>
  <div class="cell"><a href="/track/test/123">Track</a></div></div></main>
  <div ${playerAttributes}><div class="Player_titleRow__fixture"><a href="/track/test/123">${titleMarkup}</a></div>
  <div class="Player_artists__fixture"><a href="/artist/test/456">Artist</a></div>
  <span class="Player_label__fixture"><a href="/label/test/789">Label</a></span>
  <a href="/release/test/999"><img alt="Artwork"></a><canvas></canvas><button aria-label="Play">Play</button></div>
  <nav><a href="/track/test/123">Unrelated navigation</a></nav>`;
 test(`${layout} rows and player keep one action per item and restore saved checkmarks offline`, async t => {
  const storage = new Map([['beatport.downloaded.v1.track:123', Date.now()-365*86400000]]);
  const h = setup(t, storage, false, {html, url:'https://www.beatport.com/genre/house/5'});
  await h.settle();
  const player = h.w.document.querySelector('main + div');
  const buttons = [...h.w.document.querySelectorAll('.tm-beatportdl-local-icon')];
  assert.equal(buttons.length, 4, 'one row control plus track, artist and label in player');
  assert.equal(h.w.document.querySelectorAll('main button').length, 1);
  assert.equal(player.querySelectorAll('.tm-beatportdl-local-icon').length, 3);
  assert.equal(player.querySelector('canvas').childNodes.length, 0);
  assert.equal(h.w.document.querySelector('nav button'), null);
  for (const button of buttons.filter(b=>b.dataset.tmBeatportMediaKey==='track:123')) {
   assert.equal(button.textContent, '✓'); assert.match(button.title, /Downloaded/);
  }
  h.w.GM_setValue('beatport.downloaded.v1.artist:456', Date.now());
  assert.equal(player.querySelector('[data-tm-beatport-media-key="artist:456"]').textContent, '✓');

  // React keeps the link but changes the now-playing ID and nested marquee text.
  const track = player.querySelector('a[href^="/track/"]'), icon = track.nextElementSibling;
  track.href='/track/next/321'; track.querySelector('span').firstChild.data='Next';
  await h.settle();
  assert.equal(track.nextElementSibling, icon);
  assert.equal(icon.textContent, '⇩');
  assert.equal(icon.classList.contains('tm-beatportdl-local-downloaded'), false);
  assert.match(icon.title, /Next/);
  track.querySelector('span').firstChild.data='Renamed';
  await h.settle(); assert.match(icon.title, /Renamed/);
  assert.equal(h.w.document.querySelector('main button').textContent, '✓', 'list mark remains independent');

  // A partial cell update must reconcile the previous winner in another cell.
  const duplicate = h.w.document.querySelector('main .cell + .cell a');
  duplicate.textContent='A more descriptive track title with the same ID';
  await h.settle();
  assert.equal(h.w.document.querySelectorAll('main button').length, 1);
  assert.equal(duplicate.nextElementSibling.textContent, '✓');
  duplicate.parentElement.remove(); await h.settle();
  assert.equal(h.w.document.querySelector('main button').textContent, '✓');
 });
 test(`${layout} download actions do not activate row/player pointer or keyboard shortcuts`, async t => {
  const h = setup(t, new Map(), false, {html, url:'https://www.beatport.com/genre/house/5'});
  await h.settle(); let shortcuts=0, copied='';
  h.w.GM_setClipboard=value=>{copied=value;};
  for(const type of ['click','pointerdown','pointerup','mousedown','mouseup','dblclick','keydown','keyup']) {
   h.w.document.addEventListener(type, ()=>shortcuts++);
  }
  const icon=h.w.document.querySelector('main + div .tm-beatportdl-local-icon');
  for(const type of ['pointerdown','pointerup','mousedown','mouseup','dblclick']) icon.dispatchEvent(new h.w.MouseEvent(type,{bubbles:true}));
  for(const type of ['keydown','keyup']) for(const key of ['Enter',' ']) {
   const event=new h.w.KeyboardEvent(type,{key,bubbles:true,cancelable:true}); icon.dispatchEvent(event);
   assert.equal(event.defaultPrevented,false,'native keyboard activation is retained');
  }
  icon.dispatchEvent(new h.w.MouseEvent('click',{bubbles:true,shiftKey:true}));
  assert.equal(copied,'https://www.beatport.com/track/test/123'); assert.equal(shortcuts,0);
  h.w.document.querySelector('[aria-label="Play"]').click();
  h.w.document.body.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:' ',bubbles:true}));
  assert.equal(shortcuts,2,'normal player clicks and page shortcuts are unchanged');
  // A pending copy/job indicator cannot migrate to another now-playing track.
  const link=icon.previousElementSibling; link.href='/track/next/321';
  await h.settle(); assert.equal(icon.disabled,false); assert.equal(icon.textContent,'⇩');
  assert.equal(icon.classList.contains('tm-beatportdl-local-queued'),false);
 });
}

test('nested headings still reconcile after row-scoped mutation batching', async t => {
 const h=setup(t,new Map(),false,{html:'<main><article><h1>Track <span>name</span></h1></article></main>'});
 await h.settle(); h.w.document.querySelector('h1 span').firstChild.data='renamed';
 await h.settle(); assert.match(h.w.document.querySelector('h1 + button').title,/renamed/);
});

test('scrolling metadata never duplicates actions or names and keeps buttons outside ellipsized text', async t => {
 const h=setup(t,new Map([['beatport.downloaded.v1.artist:456',Date.now()]]),false,{
  html:`<main></main><div data-testid="bp-player">
   <div class="Player_titleRow__fixture"><a href="/track/test/123"><div data-testid="marquee-parent">
    <div>Track Original Mix</div><div data-testid="marquee-pseudo">Track Original Mix</div></div></a></div>
   <div data-testid="marquee-parent" id="artists"><div class="Marquee-style__MarqueeElement-fixture"><div class="Player_artists__fixture">
    <a href="/artist/first/456">First artist with a long name</a>, <a href="/artist/second/789">Second artist with a long name</a>
   </div></div></div><canvas></canvas><button aria-label="Play">Play</button></div>`,
  url:'https://www.beatport.com/genre/house/5'
 });
 await h.settle();
 const artists=h.w.document.getElementById('artists'),original=artists.firstElementChild;
 // Beatport creates its marquee copy after measuring text, potentially after
 // our first pass. Test copies with existing DOM controls as well as new text.
 const copy=original.cloneNode(true);copy.dataset.testid='marquee-pseudo';artists.appendChild(copy);
 await h.settle();
 assert.equal(copy.querySelectorAll('button').length,0);
 assert.equal(artists.querySelectorAll('button').length,2);
 assert.equal(original.querySelector('button').textContent,'✓');
 assert(artists.classList.contains('tm-beatportdl-action-marquee'));
 assert.equal(h.w.getComputedStyle(copy).display,'none');
 assert.equal(h.w.getComputedStyle(original).animation,'none');
 for(const a of original.querySelectorAll('a')) {
  assert.equal(h.w.getComputedStyle(a).textOverflow,'ellipsis');
  assert.equal(a.nextElementSibling.tagName,'BUTTON','action is outside truncated link');
 }
 const title=h.w.document.querySelector('[data-tm-beatport-media-key="track:123"]');
 assert.equal(title.title.match(/Track Original Mix/g).length,1);
 assert.equal(h.w.getComputedStyle(h.w.document.querySelector('canvas')).display,'inline');
 original.querySelectorAll('a').forEach(a=>a.href='/genre/house/5');
 await h.settle();
 assert.equal(artists.querySelectorAll('button').length,0);
 assert.equal(artists.classList.contains('tm-beatportdl-action-marquee'),false,'styles released with actions');
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
