import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../reader/static/gaze-snap.js', import.meta.url), 'utf8');
const cursorSource = await readFile(new URL('../reader/static/gaze-cursor.js', import.meta.url), 'utf8');
const { buildTextRows, GapSnapEngine, GazeSnapper } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { GazeCursor } = await import(`data:text/javascript;base64,${Buffer.from(cursorSource).toString('base64')}`);

const bounds = { left: 0, top: 0, right: 300, bottom: 400 };
const fragment = (key, left, right, top = 100, bottom = 120, element = { key }) => ({
  key, element, rect: { left, right, top, bottom },
});
const fragments = () => [fragment('a',10,40), fragment('b',50,90), fragment('c',100,150),
  fragment('d',10,40,144,164), fragment('e',50,90,144,164)];
function engineWith(words = fragments()) {
  const engine = new GapSnapEngine();
  engine.setLayout(buildTextRows(words, bounds), bounds);
  return engine;
}

test('visual rows expose only real word gaps and line boundary slots', () => {
  const rows = buildTextRows(fragments().reverse(), bounds);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].slots.map(slot => [slot.x,slot.y]), [[6,110],[45,110],[95,110],[154,110]]);
  assert.deepEqual(rows[1].slots.map(slot => [slot.x,slot.y]), [[6,154],[45,154],[94,154]]);
  const overlapping = buildTextRows([fragment('a',10,60),fragment('b',50,90)], bounds);
  assert.equal(overlapping[0].slots.length, 2);
});

test('wrapped word fragments form separate rows with the same semantic element', () => {
  const element = { word: 'long-word' };
  const engine = engineWith([fragment('word-0',10,90,100,120,element), fragment('word-1',10,50,144,164,element)]);
  engine.feed(30,154,0);
  const position = engine.feed(30,154,100);
  assert.equal(engine.rows.length, 2);
  assert.equal(position.target, element);
  assert.equal(position.targetY, 154);
});

test('initial selection needs stable observed samples for 100 ms', () => {
  const engine = engineWith();
  const first = engine.feed(30,110,0);
  assert.equal(first, null);
  assert.equal(engine.feed(31,111,90), null);
  const confirmed = engine.feed(29,109,100);
  assert.equal(confirmed.target.key, 'a');
  assert.equal(confirmed.targetX, 25);
  assert.equal(confirmed.pending, false);
});

test('semantic word under gaze is explicit even when caret is in whitespace', () => {
  const engine = engineWith();
  engine.feed(65,110,0);
  const point = engine.feed(65,110,100);
  assert.equal(point.x, 45);
  assert.equal(point.target.key, 'b');
  assert.equal(point.targetX, 70);
  assert.equal(point.targetY, 110);
  assert.notEqual(point.x, point.targetX);
});

test('slot hysteresis suppresses oscillation near a boundary', () => {
  const engine = engineWith();
  engine.feed(65,110,0);
  engine.feed(65,110,100);
  for (const [time,x] of [[120,72],[160,68],[200,74],[240,71]]) {
    const point = engine.feed(x,110,time);
    assert.equal(point.x,45);
    assert.equal(point.target.key,'b');
    assert.equal(point.pending,false);
  }
});

test('unconfirmed shifts retain old visual gap but never return old semantic target', () => {
  const engine = engineWith();
  engine.feed(30,110,0);
  engine.feed(30,110,100);
  const pending = engine.feed(120,110,120);
  assert.equal(pending.x,45);
  assert.equal(pending.target,null);
  assert.equal(pending.targetX,null);
  assert.equal(engine.feed(120,110,200).target,null);
  const confirmed = engine.feed(120,110,220);
  assert.equal(confirmed.x,95);
  assert.equal(confirmed.target.key,'c');
});

test('semantic transition at a shared gap also requires stability', () => {
  const engine = engineWith();
  engine.feed(30,110,0);
  engine.feed(30,110,100);
  const pending = engine.feed(65,110,120);
  assert.equal(pending.x,45);
  assert.equal(pending.target,null);
  const confirmed = engine.feed(65,110,220);
  assert.equal(confirmed.x,45);
  assert.equal(confirmed.target.key,'b');
});

test('candidate jitter cannot accumulate confirmation across different selections', () => {
  const engine = engineWith();
  engine.feed(30,110,0);
  engine.feed(30,110,100);
  engine.feed(120,110,120);
  assert.equal(engine.feed(30,110,170).target.key,'a');
  assert.equal(engine.feed(120,110,200).target,null);
  assert.equal(engine.feed(120,110,250).target,null);
  assert.equal(engine.feed(120,110,300).target.key,'c');
});

test('large blank areas and points outside the article hide instead of clamping', () => {
  const engine = engineWith();
  engine.feed(30,110,0);
  engine.feed(30,110,100);
  assert.equal(engine.feed(250,110,120),null);
  assert.equal(engine.feed(30,230,140),null);
  assert.equal(engine.feed(-1,110,160),null);
  assert.equal(engine.feed(30,110,180),null);
});

test('row transition is bounded and must settle before returning another word', () => {
  const engine = engineWith();
  engine.feed(30,110,0);
  engine.feed(30,110,100);
  assert.equal(engine.feed(30,132,120).target.key,'a');
  const shift = engine.feed(30,154,160);
  assert.equal(shift.y,110);
  assert.equal(shift.target,null);
  const next = engine.feed(30,154,260);
  assert.equal(next.y,154);
  assert.equal(next.target.key,'d');
});

test('stale gaps and replacing geometry remove the prior semantic selection', () => {
  const engine = engineWith();
  engine.feed(30,110,0);
  engine.feed(30,110,100);
  assert.equal(engine.feed(30,110,600),null);
  engine.feed(30,110,700);
  engine.setLayout(buildTextRows([fragment('new',10,40)],bounds),bounds);
  assert.equal(engine.feed(30,110,720),null);
  assert.equal(engine.feed(30,110,820).target.key,'new');
});

function withDOM(run) {
  const keys = ['window','document','performance','setTimeout','clearTimeout','ResizeObserver','MutationObserver'];
  const saved = new Map(keys.map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  let now = 1000, timerId = 0;
  const timers = new Map(), observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
    notify() { this.callback(); }
  }
  const body = { parentElement: null, append(element) { element.parentElement = this; } };
  const rootBounds = { left: 50, top: 80, right: 400, bottom: 500 };
  const words = [fragment('a',100,140),fragment('b',150,190)].map(f => ({
    key:f.key, rect:f.rect, getClientRects() { return [this.rect]; },
  }));
  const root = { parentElement:body, isConnected:true, getBoundingClientRect:() => rootBounds,
    querySelectorAll:() => words, contains:element => element === root || words.includes(element) };
  const doc = new EventTarget(), win = new EventTarget();
  doc.hidden = false; doc.hasFocus = () => true; doc.body = body;
  doc.fonts = new EventTarget(); doc.dialog = null; doc.occluded = false;
  doc.querySelector = () => doc.dialog;
  doc.querySelectorAll = () => doc.dialog ? [doc.dialog] : [];
  doc.elementFromPoint = () => doc.occluded ? body : root;
  win.innerWidth = 1000; win.innerHeight = 800;
  const element = { hidden:false, style:{}, parentElement:body };
  const replacements = { window:win, document:doc, performance:{now:()=>now},
    ResizeObserver:Observer, MutationObserver:Observer,
    setTimeout(fn,delay) { const id=++timerId; timers.set(id,{fn,at:now+delay}); return id; },
    clearTimeout(id) { timers.delete(id); } };
  for (const [key,value] of Object.entries(replacements)) Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  const snapper = new GazeSnapper({root}), cursor = new GazeCursor({element,snapper});
  cursor.setEnabled(true);
  const environment = {cursor,snapper,element,root,rootBounds,words,doc,win,observers,
    feed:(x=130,y=110) => cursor.feed(x,y,now),
    advance(ms) {
      now+=ms;
      for (const [id,timer] of [...timers]) if (timer.at<=now) {timers.delete(id);timer.fn();}
    } };
  try {run(environment);} finally {
    cursor.destroy();
    for (const [key,descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
    }
  }
}

test('cursor renders the snapped gap and returns the actual word target coordinates',()=>withDOM(e=>{
  assert.equal(e.feed(),null);
  assert.equal(e.element.hidden,true);
  e.advance(100);
  const point=e.feed();
  assert.equal(point.x,145);
  assert.equal(point.target,e.words[0]);
  assert.equal(point.targetX,120);
  assert.equal(e.element.style.transform,'translate3d(145px, 110px, 0)');
  e.cursor.setVisible(false);
  e.advance(20);
  assert.equal(e.feed().target,e.words[0]);
  assert.equal(e.element.hidden,true);
}));

test('raw gaze outside nearby text hides even if its smoothed point remains on text',()=>withDOM(e=>{
  e.feed(); e.advance(100); e.feed(); e.advance(1);
  assert.equal(e.feed(300,110),null);
  assert.equal(e.element.hidden,true);
}));

test('dialogs, occluding surfaces, and removed articles cannot target underlying text',()=>withDOM(e=>{
  e.feed(); e.advance(100); e.feed();
  e.doc.dialog={open:true}; e.advance(10);
  assert.equal(e.feed(),null);
  assert.equal(e.element.hidden,true);
  e.doc.dialog=null; e.doc.occluded=true; e.advance(10);
  assert.equal(e.feed(),null);
  e.doc.occluded=false; e.root.isConnected=false; e.advance(10);
  assert.equal(e.feed(),null);
}));

test('font/layout/content invalidation immediately hides and discards semantic state',()=>withDOM(e=>{
  for (const invalidate of [()=>e.snapper.invalidate(),()=>e.observers[0].notify(),
    ()=>e.observers[1].notify(),()=>e.doc.fonts.dispatchEvent(new Event('loadingdone'))]) {
    e.advance(1); e.feed(); e.advance(100); assert.ok(e.feed().target);
    invalidate();
    assert.equal(e.element.hidden,true);
    e.advance(10);
    assert.equal(e.feed(),null);
  }
}));

test('geometry is remeasured after invalidation instead of reusing old word positions',()=>withDOM(e=>{
  e.feed(); e.advance(100); e.feed();
  for (const word of e.words) {word.rect.top+=60;word.rect.bottom+=60;}
  e.snapper.invalidate(); e.advance(10);
  const pending=e.feed(130,170);
  assert.equal(pending,null);
  assert.equal(e.element.hidden,true);
  e.advance(100);
  assert.equal(e.feed(130,170).targetY,170);
}));

test('article position changes invalidate the cached layout without a resize event',()=>withDOM(e=>{
  e.feed(); e.advance(100); e.feed();
  e.rootBounds.top+=20; e.rootBounds.bottom+=20;
  for (const word of e.words) {word.rect.top+=20;word.rect.bottom+=20;}
  e.advance(10);
  const pending=e.feed(130,130);
  assert.equal(pending,null);
  assert.equal(e.element.hidden,true);
}));

test('cursor destruction disconnects attached snapper observers and stops targeting',()=>withDOM(e=>{
  e.feed(); e.cursor.destroy();
  assert.ok(e.observers.every(observer=>observer.disconnected));
  assert.equal(e.snapper.destroyed,true);
  assert.equal(e.feed(),null);
}));
