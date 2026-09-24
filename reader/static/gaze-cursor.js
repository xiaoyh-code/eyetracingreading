/** Filter actual viewport samples; never invent additional gaze observations. */
export class GazeFilter {
  constructor({ smoothingMs = 80, staleMs = 480 } = {}) {
    this.smoothingMs = smoothingMs;
    this.staleMs = staleMs;
    this.reset();
  }

  reset() {
    this.point = null;
    this.lastTimestamp = -Infinity;
  }

  feed(x, y, t, now, width, height) {
    if (![x, y, t, now, width, height].every(Number.isFinite)
      || t < 0 || t > now || now - t >= this.staleMs || t <= this.lastTimestamp
      || width <= 0 || height <= 0 || x < 0 || y < 0 || x >= width || y >= height) {
      // Keep the timestamp watermark until an explicit reset, so an invalid
      // observation cannot make an older sample look new again.
      this.point = null;
      return null;
    }
    const previous = this.point;
    this.lastTimestamp = t;
    if (!previous || t - previous.t >= this.staleMs) {
      this.point = { x, y, t };
    } else {
      const distance = Math.hypot(x - previous.x, y - previous.y);
      // Small movements get an 80 ms time constant; large gaze shifts catch up
      // quickly. Exponential smoothing uses elapsed time, not frame count.
      const timeConstant = Math.max(18, this.smoothingMs / (1 + Math.max(0, distance - 48) / 100));
      const alpha = 1 - Math.exp(-(t - previous.t) / timeConstant);
      this.point = { x: previous.x + alpha * (x - previous.x),
        y: previous.y + alpha * (y - previous.y), t };
    }
    return { ...this.point };
  }
}

/** A noninteractive, in-page gaze estimate. This never controls the OS mouse. */
export class GazeCursor {
  constructor({ element, snapper = null }) {
    if (!element) throw new Error('GazeCursor requires a cursor element.');
    this.element = element;
    this.element.hidden = true;
    this.filter = new GazeFilter();
    this.snapper = snapper;
    this.enabled = false;
    this.visible = true;
    this.focused = document.hasFocus();
    this.pageActive = true;
    this.destroyed = false;
    this.acceptAfter = -Infinity;
    this.timer = null;
    this.abort = new AbortController();
    this.unsubscribeSnapper = snapper?.subscribeInvalidation?.(() => this.hide());
    const options = { passive: true, signal: this.abort.signal };
    window.addEventListener('blur', () => { this.focused = false; this.hide(); }, options);
    window.addEventListener('focus', () => { this.focused = true; this.hide(); }, options);
    window.addEventListener('pagehide', () => { this.pageActive = false; this.hide(); }, options);
    window.addEventListener('pageshow', () => { this.pageActive = true; this.hide(); }, options);
    window.addEventListener('resize', () => this.hide(), options);
    // Capture catches scrolls inside article panes and open native dialogs too.
    window.addEventListener('scroll', () => this.hide(), { ...options, capture: true });
    document.addEventListener('visibilitychange', () => {
      this.focused = document.hasFocus();
      this.hide();
    }, options);
  }

  setEnabled(enabled) {
    if (this.destroyed) return;
    const next = Boolean(enabled);
    if (next === this.enabled) return;
    this.enabled = next;
    this.hide();
  }

  // Presentation only: hiding the reticle does not change the reading point.
  setVisible(visible) {
    if (this.destroyed) return;
    this.visible = Boolean(visible);
    if (!this.visible) this.element.hidden = true;
    // A new sample will show the reticle again; never redisplay an old position.
  }

  feed(x, y, t = performance.now()) {
    if (this.destroyed || !this.enabled || !this.focused || !this.pageActive || document.hidden) return null;
    const now = performance.now();
    if (t < this.acceptAfter) { this.hide(); return null; }
    let point = this.filter.feed(x, y, t, now, window.innerWidth, window.innerHeight);
    if (!point) { this.hide(); return null; }
    if (this.snapper) {
      point = this.snapper.feed(point.x, point.y, point.t, { rawX: x, rawY: y });
      if (t < this.acceptAfter) { this.hide(); return null; }
      if (!point) {
        if (this.snapper.pending) {
          // Initial acquisition must settle before displaying any gap. Preserve
          // candidate/filter state while withholding both visual and target.
          this.element.hidden = true;
          this.element.style.transform = '';
          this._expireAt(t, now);
        } else this.hide();
        return null;
      }
    }
    if (this.visible) this._mount();
    this.element.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    this.element.hidden = !this.visible;
    this._expireAt(point.t, now);
    return point;
  }

  _expireAt(t, now) {
    clearTimeout(this.timer);
    // This timer only hides/reset state. It never emits interpolated points or
    // invokes ReadingTracker, so it cannot manufacture fixation time.
    this.timer = setTimeout(() => this.hide(), Math.max(0, t + this.filter.staleMs - now));
  }

  _mount() {
    if (this.snapper) {
      if (this.element.parentElement !== document.body) document.body.append(this.element);
      return;
    }
    // Native modal dialogs live in the top layer, above even a high body z-index.
    // Move only this noninteractive reticle, never the user's focused control.
    const focusedDialog = document.activeElement?.closest?.('dialog[open]');
    const dialogs = document.querySelectorAll('dialog[open]');
    const parent = focusedDialog ?? dialogs[dialogs.length - 1] ?? document.body;
    if (this.element.parentElement !== parent) parent.append(this.element);
  }

  hide() {
    clearTimeout(this.timer);
    this.timer = null;
    this.element.hidden = true;
    this.element.style.transform = '';
    this.filter.reset();
    this.snapper?.reset();
    this.acceptAfter = performance.now();
  }

  destroy() {
    if (this.destroyed) return;
    this.enabled = false;
    this.destroyed = true;
    this.abort.abort();
    this.hide();
    this.unsubscribeSnapper?.();
    this.snapper?.destroy();
  }
}
