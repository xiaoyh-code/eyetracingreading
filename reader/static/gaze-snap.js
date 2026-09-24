const finiteRect = rect => rect && ['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(rect[key]))
  && rect.right > rect.left && rect.bottom > rect.top;
const inside = (x, y, rect) => rect && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
const horizontalDistance = (x, rect) => Math.max(rect.left - x, 0, x - rect.right);

/** Build visual lines from individual rendered word fragments, including wraps. */
export function buildTextRows(fragments, bounds) {
  if (!finiteRect(bounds)) return [];
  const rows = [];
  const sorted = fragments.filter(fragment => finiteRect(fragment.rect))
    .map(fragment => ({ ...fragment, rect: { ...fragment.rect } }))
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  for (const fragment of sorted) {
    const rect = fragment.rect;
    const center = (rect.top + rect.bottom) / 2;
    const height = rect.bottom - rect.top;
    let row = rows.find(candidate => Math.abs(candidate.y - center)
      <= Math.max(2, Math.min(candidate.bottom - candidate.top, height) * .35));
    if (!row) {
      row = { words: [], top: rect.top, bottom: rect.bottom, y: center };
      rows.push(row);
    }
    row.words.push(fragment);
    row.top = Math.min(row.top, rect.top);
    row.bottom = Math.max(row.bottom, rect.bottom);
    row.y = (row.top + row.bottom) / 2;
  }
  return rows.sort((a, b) => a.top - b.top).map((row, rowIndex) => {
    row.id = `line-${rowIndex}`;
    row.words.sort((a, b) => a.rect.left - b.rect.left);
    row.left = row.words[0].rect.left;
    row.right = Math.max(...row.words.map(word => word.rect.right));
    row.slots = [{ id: `${row.id}-start`, x: Math.max(bounds.left, row.left - 4), y: row.y }];
    for (let index = 1; index < row.words.length; index++) {
      const previous = row.words[index - 1].rect, next = row.words[index].rect;
      // Overlapping text has no genuine gap: do not place a caret inside it.
      if (next.left >= previous.right) row.slots.push({
        id: `${row.id}-gap-${index}`, x: (previous.right + next.left) / 2, y: row.y,
      });
    }
    row.slots.push({ id: `${row.id}-end`, x: Math.min(bounds.right - .01, row.right + 4), y: row.y });
    return row;
  });
}

/** Deterministic gap selection; geometry and time are supplied by the caller. */
export class GapSnapEngine {
  constructor({ stabilityMs = 100, hysteresisPx = 8, lineHysteresisPx = 6,
    wordHysteresisPx = 4, maxLineDistance = 14, edgeTolerance = 10, staleMs = 480 } = {}) {
    Object.assign(this, { stabilityMs, hysteresisPx, lineHysteresisPx,
      wordHysteresisPx, maxLineDistance, edgeTolerance, staleMs });
    this.setLayout([], null);
  }

  setLayout(rows, bounds) {
    this.rows = rows;
    this.bounds = bounds;
    this.reset();
  }

  reset() {
    this.active = null;
    this.candidate = null;
    this.lastTime = -Infinity;
  }

  rowAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !inside(x, y, this.bounds)) return null;
    const nearby = this.rows.filter(row => {
      const tolerance = Math.min(this.maxLineDistance, (row.bottom - row.top) * .65);
      return x >= row.left - this.edgeTolerance && x <= row.right + this.edgeTolerance
        && y >= row.top - tolerance && y <= row.bottom + tolerance;
    }).sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y));
    if (!nearby.length) return null;
    const previous = this.active?.row;
    if (previous && nearby.includes(previous)
      && Math.abs(previous.y - y) <= Math.abs(nearby[0].y - y) + this.lineHysteresisPx) return previous;
    return nearby[0];
  }

  feed(x, y, t) {
    if (!Number.isFinite(t) || t < 0 || t <= this.lastTime) { this.reset(); return null; }
    if (t - this.lastTime >= this.staleMs) this.reset();
    this.lastTime = t;
    const row = this.rowAt(x, y);
    if (!row) { this.reset(); return null; }
    let slot = row.slots.reduce((best, current) => Math.abs(current.x - x) < Math.abs(best.x - x) ? current : best);
    let word = row.words.reduce((best, current) => {
      const a = horizontalDistance(x, current.rect), b = horizontalDistance(x, best.rect);
      if (a !== b) return a < b ? current : best;
      return Math.abs((current.rect.left + current.rect.right) / 2 - x)
        < Math.abs((best.rect.left + best.rect.right) / 2 - x) ? current : best;
    });
    if (this.active?.row === row) {
      if (Math.abs(this.active.slot.x - x) <= Math.abs(slot.x - x) + this.hysteresisPx) slot = this.active.slot;
      if (horizontalDistance(x, this.active.word.rect) <= horizontalDistance(x, word.rect) + this.wordHysteresisPx) {
        word = this.active.word;
      }
    }
    const key = `${slot.id}:${word.key}`;
    const selected = { key, row, slot, word };
    if (this.active?.key === key) {
      this.candidate = null;
      return this._point(this.active, t, false);
    }
    if (this.candidate?.selection.key !== key) this.candidate = { selection: selected, since: t };
    if (t - this.candidate.since >= this.stabilityMs) {
      this.active = selected;
      this.candidate = null;
      return this._point(this.active, t, false);
    }
    // Hold the last displayed gap while a new selection settles, but withhold
    // its semantic target so the old word cannot keep accruing dwell time.
    return this.active ? this._point(this.active, t, true) : null;
  }

  _point(selection, t, pending) {
    const { slot, word } = selection;
    return { x: slot.x, y: slot.y, t, slotId: slot.id, pending,
      target: pending ? null : word.element,
      targetX: pending ? null : (word.rect.left + word.rect.right) / 2,
      targetY: pending ? null : (word.rect.top + word.rect.bottom) / 2 };
  }
}

/** Article-specific geometry cache and lifecycle around the pure snap engine. */
export class GazeSnapper {
  constructor({ root, ...options }) {
    if (!root) throw new Error('GazeSnapper requires an article root.');
    this.root = root;
    this.engine = new GapSnapEngine(options);
    this.dirty = true;
    this.destroyed = false;
    this.boundsKey = null;
    this.listeners = new Set();
    this.abort = new AbortController();
    const events = { passive: true, signal: this.abort.signal };
    window.addEventListener('scroll', () => this.invalidate(), { ...events, capture: true });
    window.addEventListener('resize', () => this.invalidate(), events);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.invalidate());
      this.resizeObserver.observe(root);
    }
    if (typeof MutationObserver !== 'undefined') {
      this.contentObserver = new MutationObserver(() => this.invalidate());
      this.contentObserver.observe(root, { childList: true, subtree: true, characterData: true });
      this.styleObserver = new MutationObserver(() => this.invalidate());
      // Ancestor font/layout changes matter; per-word focus classes do not.
      for (let element = root; element; element = element.parentElement) {
        this.styleObserver.observe(element, { attributes: true, attributeFilter: ['style', 'class'] });
      }
    }
    document.fonts?.addEventListener?.('loadingdone', () => this.invalidate(), events);
    document.fonts?.ready?.then(() => { if (!this.destroyed) this.invalidate(); });
  }

  subscribeInvalidation(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidate() {
    if (this.destroyed) return;
    this.dirty = true;
    this.engine.reset();
    for (const listener of this.listeners) listener();
  }

  reset() { this.engine.reset(); }

  get pending() { return Boolean(this.engine.candidate); }

  feed(x, y, t, { rawX = x, rawY = y } = {}) {
    if (this.destroyed || document.querySelector('dialog[open]') || !this.root.isConnected) {
      this.reset();
      return null;
    }
    const measured = this.root.getBoundingClientRect();
    const bounds = { left: Math.max(0, measured.left), top: Math.max(0, measured.top),
      right: Math.min(window.innerWidth, measured.right), bottom: Math.min(window.innerHeight, measured.bottom) };
    const key = [bounds.left, bounds.top, bounds.right, bounds.bottom].join(':');
    if (this.boundsKey !== null && this.boundsKey !== key) this.invalidate();
    this.boundsKey = key;
    if (this.dirty) this._measure(bounds);
    // Check the original sample too: smoothing must not drag an outside gaze
    // back into the article, a nearby row, or through an overlay.
    const hit = Number.isFinite(rawX) && Number.isFinite(rawY) ? document.elementFromPoint(rawX, rawY) : null;
    if (!this.engine.rowAt(rawX, rawY) || !hit || !this.root.contains(hit)) {
      this.reset();
      return null;
    }
    return this.engine.feed(x, y, t);
  }

  _measure(bounds) {
    const fragments = [];
    for (const [wordIndex, element] of [...this.root.querySelectorAll('.word')].entries()) {
      for (const [fragmentIndex, measured] of [...element.getClientRects()].entries()) {
        const rect = { left: Math.max(bounds.left, measured.left), top: Math.max(bounds.top, measured.top),
          right: Math.min(bounds.right, measured.right), bottom: Math.min(bounds.bottom, measured.bottom) };
        if (finiteRect(rect)) fragments.push({ key: `${wordIndex}-${fragmentIndex}`, element, rect });
      }
    }
    this.engine.setLayout(buildTextRows(fragments, bounds), bounds);
    this.dirty = false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    this.resizeObserver?.disconnect();
    this.contentObserver?.disconnect();
    this.styleObserver?.disconnect();
    this.listeners.clear();
    this.engine.setLayout([], null);
  }
}
