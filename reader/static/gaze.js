/* Pure fixation logic, with a small DOM adapter below. Coordinates are viewport CSS pixels. */
const noop = () => {};
const sameWord = (a, b) => a?.wordId === b?.wordId && Boolean(a) === Boolean(b);

export class FixationEngine {
  constructor({ onFocus = noop, onAssist = noop, onProgress = noop,
    dwellMs = 1800, revisitCount = 3, total = 0, freshMs = Infinity,
    debounceMs = 100, fixationMs = 220, sentenceMs = 400, cooldownMs = 12000 } = {}) {
    Object.assign(this, { onFocus, onAssist, onProgress, total, freshMs,
      debounceMs, fixationMs, sentenceMs, cooldownMs });
    this.configure({ dwellMs, revisitCount });
    this.reset();
  }

  configure({ dwellMs, revisitCount } = {}) {
    if (Number.isFinite(Number(dwellMs))) this.dwellMs = Math.max(500, Number(dwellMs));
    if (Number.isFinite(Number(revisitCount))) this.revisitCount = Math.max(2, Number(revisitCount));
  }

  reset(total = this.total) {
    this.total = total;
    this.seen = new Set();
    this.visits = new Map();
    this.assistedAt = new Map();
    this.lastQualifiedSentence = null;
    this.interrupt();
    this.reportProgress();
  }

  interrupt() {
    this.target = null;
    this.active = null;
    this.candidateAt = null;
    this.sentenceId = null;
    this.sentenceAt = null;
    this.outsideAt = null;
    this.lastClock = null;
    this.lastSample = -Infinity;
    // Interruption must not fabricate another reading visit on resume.
    this.onFocus(null);
  }

  observe(token, t) {
    if (!Number.isFinite(t)) return;
    this.tick(t);
    this.lastSample = t;
    if (!sameWord(token, this.target)) {
      this.target = token;
      this.candidateAt = t;
    }
    const sentenceId = token?.sentenceId ?? null;
    if (sentenceId !== this.sentenceId) {
      this.sentenceId = sentenceId;
      this.sentenceAt = t;
    }
    if (token) this.outsideAt = null;
    else if (this.outsideAt === null) this.outsideAt = t;
    this.lastClock = t;
  }

  tick(t) {
    if (!Number.isFinite(t)) return;
    if (t - this.lastSample >= this.freshMs) {
      if (this.target || this.active) this.interrupt();
      return;
    }
    const delta = this.lastClock === null ? 0 : Math.max(0, t - this.lastClock);
    this.lastClock = t;
    if (!this.target) {
      if (this.active && t - this.candidateAt >= this.debounceMs) {
        this.active = null;
        this.onFocus(null);
      }
      if (this.outsideAt !== null && t - this.outsideAt >= 700) {
        this.lastQualifiedSentence = null;
      }
      return;
    }
    if (!sameWord(this.target, this.active?.token)) {
      if (t - this.candidateAt < this.debounceMs) return;
      this.active = { token: this.target, elapsed: t - this.candidateAt, triggered: false };
    } else {
      this.active.elapsed += delta;
    }
    const { token, elapsed } = this.active;
    this.onFocus({ ...token, elapsed, ratio: Math.min(1, elapsed / this.dwellMs) });
    if (elapsed >= this.fixationMs && !this.seen.has(token.wordId)) {
      this.seen.add(token.wordId);
      this.reportProgress();
    }
    if (t - this.sentenceAt >= this.sentenceMs && this.lastQualifiedSentence !== token.sentenceId) {
      this.lastQualifiedSentence = token.sentenceId;
      const visits = (this.visits.get(token.sentenceId) ?? 0) + 1;
      this.visits.set(token.sentenceId, visits);
      if (visits >= this.revisitCount) this.assist(token, 'reread', t);
    }
    if (elapsed >= this.dwellMs && !this.active.triggered) {
      this.active.triggered = true;
      this.assist(token, 'dwell', t);
    }
  }

  assist(token, reason, t) {
    const previous = this.assistedAt.get(token.sentenceId) ?? -Infinity;
    if (t - previous < this.cooldownMs) return;
    this.assistedAt.set(token.sentenceId, t);
    this.onAssist({ ...token, reason, visits: this.visits.get(token.sentenceId) ?? 1 });
  }

  reportProgress() {
    this.onProgress({ seen: this.seen.size, total: this.total,
      ratio: this.total ? this.seen.size / this.total : 0 });
  }
}

export class ReadingTracker {
  constructor({ root, onFocus, onAssist, onProgress, onStatus = noop,
    dwellMs = 1800, revisitCount = 3 }) {
    if (!root) throw new Error('ReadingTracker requires an article root.');
    this.root = root;
    this.onStatus = onStatus;
    this.mode = 'mouse';
    this.paused = false;
    this.focused = document.hasFocus();
    this.engine = new FixationEngine({ onFocus, onAssist, onProgress, dwellMs, revisitCount,
      total: root.querySelectorAll('.word').length });
    this.abort = new AbortController();
    const options = { signal: this.abort.signal, passive: true };
    document.addEventListener('pointermove', (event) => {
      if (this.mode === 'mouse') this.feed(event.clientX, event.clientY);
    }, options);
    document.addEventListener('pointerleave', () => this.engine.interrupt(), options);
    window.addEventListener('blur', () => {
      this.focused = false;
      this.engine.interrupt();
    }, options);
    window.addEventListener('focus', () => {
      this.focused = true;
      this.engine.interrupt();
    }, options);
    window.addEventListener('scroll', () => this.engine.interrupt(), { ...options, capture: true });
    window.addEventListener('resize', () => this.engine.interrupt(), options);
    document.addEventListener('visibilitychange', () => this.engine.interrupt(), options);
    this.timer = setInterval(() => {
      if (!this.paused && this.focused && !document.hidden) this.engine.tick(performance.now());
    }, 40);
  }

  setMode(mode) {
    if (mode !== 'mouse' && mode !== 'camera') throw new Error('Unknown reading input mode.');
    this.mode = mode;
    this.engine.freshMs = mode === 'camera' ? 480 : Infinity;
    this.engine.interrupt();
    this.onStatus({ state: mode, message: mode === 'camera' ? '鏡頭追蹤（實驗模式）' : '滑鼠閱讀模式' });
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    this.engine.interrupt();
  }

  configure(options) { this.engine.configure(options); }

  feed(x, y, t = performance.now()) {
    let element = Number.isFinite(x) && Number.isFinite(y) ? document.elementFromPoint(x, y) : null;
    element = element?.closest('.word') ?? null;
    this.feedElement(element, t);
  }

  feedElement(element, t = performance.now()) {
    if (this.paused || !this.focused || document.hidden) return;
    if (!element?.matches('.word') || !this.root.contains(element)) {
      this.engine.observe(null, t);
      return;
    }
    const sentence = element.closest('.sentence');
    const token = { element, word: element.textContent.trim(),
      wordId: element.dataset.wordId, sentenceId: element.dataset.sentenceId ?? sentence?.dataset.sentenceId,
      sentence: sentence?.textContent.trim() ?? element.textContent.trim() };
    this.engine.observe(token, t);
  }

  reset() { this.engine.reset(this.root.querySelectorAll('.word').length); }

  destroy() {
    clearInterval(this.timer);
    this.abort.abort();
    this.engine.interrupt();
  }
}
