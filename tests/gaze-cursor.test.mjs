import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../reader/static/gaze-cursor.js', import.meta.url), 'utf8');
const { GazeFilter, GazeCursor } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const filtered = (filter, x, y, t, now = t) => filter.feed(x, y, t, now, 1000, 800);

test('small-motion smoothing is based on elapsed time, not frame count', () => {
  const atRate = step => {
    const filter = new GazeFilter();
    filtered(filter, 100, 100, 0);
    let point;
    for (let t = step; t <= 160; t += step) point = filtered(filter, 130, 100, t);
    return point;
  };
  const slow = atRate(40), fast = atRate(10);
  assert.ok(Math.abs(slow.x - fast.x) < 1e-9);
  assert.ok(Math.abs(slow.x - (100 + 30 * (1 - Math.exp(-2)))) < 1e-9);
  assert.equal(slow.y, 100);
});

test('filter softens small jitter while following large gaze shifts faster', () => {
  const small = new GazeFilter(), large = new GazeFilter();
  filtered(small, 100, 100, 0);
  filtered(large, 100, 100, 0);
  const smallPoint = filtered(small, 110, 100, 16);
  const largePoint = filtered(large, 700, 100, 16);
  assert.ok(smallPoint.x - 100 < 2);
  assert.ok((largePoint.x - 100) / 600 > .5);
});

test('invalid, future, duplicate, reversed, and stale observations are rejected', () => {
  const filter = new GazeFilter();
  assert.deepEqual(filtered(filter, 100, 100, 100), { x: 100, y: 100, t: 100 });
  assert.equal(filtered(filter, NaN, 100, 110), null);
  assert.equal(filtered(filter, 100, Infinity, 120), null);
  assert.equal(filtered(filter, 100, 100, NaN), null);
  assert.equal(filtered(filter, 100, 100, 99, 150), null);
  assert.equal(filtered(filter, 100, 100, 100, 150), null);
  assert.equal(filtered(filter, 100, 100, 151, 150), null);
  assert.equal(filtered(filter, 100, 100, 150, 630), null);
});

test('offscreen points are rejected instead of clamped to the page edge', () => {
  const filter = new GazeFilter();
  for (const [x, y] of [[-1,100],[100,-1],[1000,100],[100,800]]) {
    assert.equal(filtered(filter, x, y, 100), null);
  }
  assert.deepEqual(filtered(filter, 0, 0, 101), { x: 0, y: 0, t: 101 });
});

test('fresh observation after a long signal gap starts at its own location', () => {
  const filter = new GazeFilter();
  filtered(filter, 100, 100, 0);
  assert.deepEqual(filtered(filter, 900, 700, 600), { x: 900, y: 700, t: 600 });
});

function withDOM(run) {
  const saved = new Map(['window','document','performance','setTimeout','clearTimeout']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let now = 1000, sequence = 0;
  const timers = new Map();
  const makeParent = () => ({ children: [], append(element) {
    if (element.parentElement) element.parentElement.children = element.parentElement.children.filter(child => child !== element);
    this.children.push(element);
    element.parentElement = this;
  } });
  const body = makeParent(), dialog = makeParent(), laterDialog = makeParent();
  const doc = new EventTarget(), win = new EventTarget();
  doc.hidden = false;
  doc.hasFocus = () => true;
  doc.body = body;
  doc.activeElement = null;
  doc.dialogs = [];
  doc.querySelectorAll = () => doc.dialogs;
  win.innerWidth = 1000;
  win.innerHeight = 800;
  const element = { hidden: false, style: {}, parentElement: null };
  body.append(element);
  const replacements = { window: win, document: doc, performance: { now: () => now },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const cursor = new GazeCursor({ element });
  const environment = { cursor, element, doc, win, body, dialog, laterDialog, timers,
    feed: (x = 100, y = 100, t = now) => cursor.feed(x, y, t),
    now: () => now,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
    } };
  try { run(environment); }
  finally {
    cursor.destroy();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('cursor begins hidden and returns its exact rendered point only while enabled', () => withDOM(e => {
  assert.equal(e.element.hidden, true);
  assert.equal(e.feed(), null);
  e.cursor.setEnabled(true);
  assert.deepEqual(e.feed(), { x: 100, y: 100, t: 1000 });
  e.advance(40);
  const point = e.feed(130, 120);
  assert.equal(e.element.style.transform, `translate3d(${point.x}px, ${point.y}px, 0)`);
  assert.equal(e.element.hidden, false);
  e.cursor.setEnabled(false);
  assert.equal(e.feed(), null);
  assert.equal(e.element.hidden, true);
}));

test('visual toggle preserves filtering and returned reading coordinates', () => withDOM(e => {
  e.cursor.setEnabled(true);
  e.feed();
  e.cursor.setVisible(false);
  e.advance(40);
  const point = e.feed(130, 100);
  assert.equal(e.element.hidden, true);
  assert.ok(point.x > 100 && point.x < 130);
  e.cursor.setVisible(true);
  assert.equal(e.element.hidden, true);
  e.advance(40);
  assert.ok(e.feed(130, 100).x > point.x);
  assert.equal(e.element.hidden, false);
}));

test('stale timeout hides at 480 ms without generating samples', () => withDOM(e => {
  e.cursor.setEnabled(true);
  e.feed();
  e.advance(479);
  assert.equal(e.element.hidden, false);
  e.advance(1);
  assert.equal(e.element.hidden, true);
  assert.equal(e.cursor.filter.point, null);
  assert.equal(e.timers.size, 0);
  e.advance(10);
  assert.deepEqual(e.feed(900,700), { x: 900, y: 700, t: 1490 });
}));

test('sample age reduces the visibility timeout, and hide requires a fresh sample', () => withDOM(e => {
  e.cursor.setEnabled(true);
  e.advance(100);
  e.feed(100,100,1000);
  e.advance(379);
  assert.equal(e.element.hidden, false);
  e.advance(1);
  assert.equal(e.element.hidden, true);
  assert.equal(e.feed(100,100,1479), null);
  e.advance(1);
  assert.ok(e.feed());
}));

test('blur and hidden pages ignore feeds until focus/visibility resumes', () => withDOM(e => {
  e.cursor.setEnabled(true);
  e.feed();
  e.win.dispatchEvent(new Event('blur'));
  e.advance(20);
  assert.equal(e.feed(), null);
  assert.equal(e.element.hidden, true);
  e.win.dispatchEvent(new Event('focus'));
  assert.ok(e.feed());
  e.doc.hidden = true;
  e.doc.dispatchEvent(new Event('visibilitychange'));
  e.advance(20);
  assert.equal(e.feed(), null);
  e.doc.hidden = false;
  e.doc.dispatchEvent(new Event('visibilitychange'));
  assert.ok(e.feed());
}));

test('scroll/resize/pagehide reset and a new page sample is required', () => withDOM(e => {
  e.cursor.setEnabled(true);
  for (const type of ['scroll','resize']) {
    e.feed();
    e.advance(10);
    e.win.dispatchEvent(new Event(type));
    assert.equal(e.element.hidden, true);
    assert.equal(e.feed(100,100,e.now()-1), null);
    e.advance(1);
    assert.ok(e.feed());
  }
  e.win.dispatchEvent(new Event('pagehide'));
  e.advance(10);
  assert.equal(e.feed(), null);
  e.win.dispatchEvent(new Event('pageshow'));
  assert.ok(e.feed());
}));

test('offscreen and invalid input immediately hide the existing cursor', () => withDOM(e => {
  e.cursor.setEnabled(true);
  e.feed();
  e.advance(10);
  assert.equal(e.feed(1100,100), null);
  assert.equal(e.element.hidden, true);
  e.advance(10);
  assert.ok(e.feed());
  e.advance(10);
  assert.equal(e.feed(NaN,100), null);
  assert.equal(e.element.hidden, true);
}));

test('cursor mounts in the active dialog without moving or focusing its control', () => withDOM(e => {
  e.cursor.setEnabled(true);
  e.doc.dialogs = [e.dialog, e.laterDialog];
  const focusedControl = { closest: () => e.dialog };
  e.doc.activeElement = focusedControl;
  e.feed();
  assert.equal(e.element.parentElement, e.dialog);
  assert.equal(e.doc.activeElement, focusedControl);
  e.doc.dialogs = [];
  e.doc.activeElement = null;
  e.advance(10);
  e.feed();
  assert.equal(e.element.parentElement, e.body);
}));

test('destroy removes event listeners and timers and prevents future rendering', () => withDOM(e => {
  e.cursor.setEnabled(true);
  e.feed();
  e.cursor.destroy();
  assert.equal(e.timers.size, 0);
  assert.equal(e.element.hidden, true);
  const barrier = e.cursor.acceptAfter;
  e.advance(10);
  e.win.dispatchEvent(new Event('scroll'));
  e.win.dispatchEvent(new Event('focus'));
  assert.equal(e.cursor.acceptAfter, barrier);
  e.cursor.setEnabled(true);
  assert.equal(e.feed(), null);
}));
