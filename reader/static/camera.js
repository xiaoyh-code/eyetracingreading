const noop = () => {};
const abortError = () => new DOMException('已取消鏡頭校準。', 'AbortError');
let libraryPromise;

function loadWebGazer() {
  if (window.webgazer) return Promise.resolve(window.webgazer);
  if (libraryPromise) return libraryPromise;
  libraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => fail(), 20000);
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      libraryPromise = null;
      reject(new Error('鏡頭元件未安裝或載入失敗。請先執行 python scripts/prepare_webgazer.py，再重新整理。'));
    };
    script.src = new URL('../vendor/webgazer.js', import.meta.url).href;
    script.onload = () => {
      clearTimeout(timer);
      if (window.webgazer) resolve(window.webgazer);
      else fail();
    };
    script.onerror = fail;
    document.head.append(script);
  });
  return libraryPromise;
}

/** Built-in or USB webcam. Webcam gaze is approximate, not a word-accurate eye tracker. */
export class CameraTracker {
  constructor({ onPoint = noop, onStatus = noop } = {}) {
    this.onPoint = onPoint;
    this.onStatus = onStatus;
    this.phase = 'off';
    this.lastFaceAt = -Infinity;
    this.lastPositions = null;
    this.frameHasFace = false;
    this.faceFrame = 0;
    this.points = [];
    this.readingStatus = null;
    this._pagehide = () => this.stop();
    window.addEventListener('pagehide', this._pagehide);
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.phase === 'reading') return Promise.resolve({ errorPx: this.errorPx });
    if (this.beginPromise) return Promise.reject(new Error('上一個鏡頭權限要求仍在等待，請先處理瀏覽器的權限提示。'));
    this.controller = new AbortController();
    this.phase = 'loading';
    this.startPromise = this._start(this.controller.signal).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async _start(signal) {
    this._overlay(signal);
    try {
      this._status('loading', '正在載入本機鏡頭模型…');
      const wg = await this._abortable(loadWebGazer(), signal);
      this._assert(signal);
      this.wg = wg;
      wg.params.faceMeshSolutionPath = new URL('../vendor/mediapipe/face_mesh', import.meta.url).href;
      wg.saveDataAcrossSessions(false);
      wg.showPredictionPoints(false);
      wg.showVideo(true);
      wg.showFaceOverlay(true);
      wg.showFaceFeedbackBox(true);
      wg.showVideoPreview(true);
      // The setter dereferences video nodes before begin(), so set its startup
      // parameters here; WebGazer applies them when creating the preview.
      wg.params.videoViewerWidth = 160;
      wg.params.videoViewerHeight = 120;
      wg.setRegression('ridge');
      wg.applyKalmanFilter(true);
      wg.clearData();
      wg.setGazeListener((data) => this._sample(data));
      this._status('permission', '請允許使用鏡頭，然後正望螢幕。影像只在此瀏覽器處理。');
      // WebGazer.end() alone does not stop its MediaStream in 3.5.3.
      const begin = Promise.resolve(wg.begin());
      this.beginPromise = begin;
      begin.then(() => {
        this.beginPromise = null;
        wg.removeMouseEventListeners();
        if (signal.aborted) this._releaseCamera();
      }, () => { this.beginPromise = null; });
      await this._abortable(begin, signal);
      this._assert(signal);
      wg.removeMouseEventListeners();
      // Drop any incidental movement captured while WebGazer initialized.
      await wg.clearData();
      this._assert(signal);
      this.calibrationViewport = [window.innerWidth, window.innerHeight];
      this.phase = 'calibration';
      this._status('calibration', '請保持頭部穩定，望住圓點，每點按 5 次。共 9 個位置。');
      await this._waitForFace(signal);
      await this._calibrate(signal);
      wg.removeMouseEventListeners();
      this.phase = 'validation';
      this._status('validation', '校準完成。接着只用眼望住 5 個測試點，不用按；這些位置不會用作訓練。');
      await this._continue('開始精準度測試', signal);
      const errorPx = await this._validate(signal);
      this._assert(signal);
      this.errorPx = errorPx;
      this.phase = 'result';
      this.title.textContent = `測試平均誤差：${Math.round(errorPx)} px`;
      this.detail.textContent = errorPx > 100
        ? '誤差較大，可能無法準確分辨相鄰文字。可繼續試用，或關閉後重新校準；光線、頭部移動和眼鏡都會影響結果。'
        : '這是剛才 5 個位置的估算，閱讀時仍可能偏移。請保持位置，必要時切回滑鼠或重新校準。';
      await this._continue('開始鏡頭閱讀', signal);
      this._assert(signal);
      this._checkViewport();
      this.overlay.remove();
      this.overlay = null;
      wg.showVideoPreview(false);
      this.phase = 'reading';
      this._status('camera', `鏡頭追蹤中 · 測試誤差 ${Math.round(errorPx)} px（實驗模式）`);
      this.healthTimer = setInterval(() => this._checkHealth(), 200);
      this.visibilityHandler = () => {
        if (document.hidden) {
          wg.pause();
          this.lastFaceAt = -Infinity;
        } else if (this.phase === 'reading') wg.resume();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
      this.resizeHandler = () => {
        this.stop();
        this._status('error', '視窗尺寸已改變。請重新校準鏡頭，或使用滑鼠閱讀。');
      };
      window.addEventListener('resize', this.resizeHandler);
      return { errorPx };
    } catch (error) {
      this._releaseCamera();
      this.overlay?.remove();
      this.overlay = null;
      this.phase = 'off';
      if (error.name !== 'AbortError') {
        const message = error.name === 'NotAllowedError'
          ? '鏡頭權限未獲允許。請在瀏覽器允許鏡頭後再試。'
          : error.name === 'NotFoundError' ? '找不到鏡頭。請連接內置或 USB 鏡頭。'
            : error.name === 'NotReadableError' ? '鏡頭未能啟動，可能正被其他程式使用。' : error.message;
        this._status('error', message);
        throw new Error(message, { cause: error });
      }
      this._status('off', '已取消鏡頭校準。');
      throw error;
    }
  }

  _sample(data) {
    const now = performance.now();
    const tracker = this.wg?.getTracker();
    const positions = tracker?.getPositions();
    // The landmark array is replaced for each detected face. An unchanged array
    // can survive lost-face frames, so its mere existence is not readiness.
    this.frameHasFace = Boolean(positions?.length && positions !== this.lastPositions && tracker.predictionReady !== false);
    if (this.frameHasFace) {
      this.lastPositions = positions;
      this.lastFaceAt = now;
      this.faceFrame++;
    }
    if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y) || !this.frameHasFace) return;
    const point = { x: data.x, y: data.y, t: now };
    if (this.collecting && !document.hidden) this.points.push(point);
    if (this.phase === 'reading' && !document.hidden) this.onPoint(point);
  }

  _checkHealth() {
    const lost = performance.now() - this.lastFaceAt > 480;
    const next = lost ? 'lost' : 'tracking';
    if (next === this.readingStatus) return;
    this.readingStatus = next;
    this._status(lost ? 'lost' : 'camera', lost
      ? '暫時未偵測到眼睛，停留計時已暫停。請正望鏡頭。'
      : `鏡頭追蹤中 · 測試誤差 ${Math.round(this.errorPx)} px（實驗模式）`);
  }

  async _waitForFace(signal) {
    const started = performance.now();
    this.detail.textContent = '正在尋找面部…請坐近一點，確保面部光線充足。';
    while (!this.frameHasFace || performance.now() - this.lastFaceAt > 350) {
      if (performance.now() - started > 30000) throw new Error('30 秒內未能穩定偵測面部。請改善光線，確認鏡頭沒有被遮擋，再試一次。');
      await this._delay(120, signal);
    }
    this.detail.textContent = '已偵測到面部。請望住圓點再按，保持頭部位置不變。Esc 可取消。';
  }

  async _calibrate(signal) {
    const points = [[.15,.24],[.5,.24],[.85,.24],[.15,.5],[.85,.5],[.15,.82],[.5,.82],[.85,.82],[.5,.5]];
    const viewport = [window.innerWidth, window.innerHeight];
    for (let index = 0; index < points.length; index++) {
      this._assert(signal);
      if (window.innerWidth !== viewport[0] || window.innerHeight !== viewport[1]) throw new Error('視窗尺寸已改變，請重新校準。');
      const [x, y] = points[index].map((value, axis) => Math.round(value * viewport[axis]));
      const button = this._dot(x, y);
      let count = 0;
      let lastClick = -Infinity;
      let lastFrame = -1;
      this.title.textContent = `校準 ${index + 1} / 9`;
      button.textContent = '5';
      await new Promise((resolve, reject) => {
        const onAbort = () => { button.remove(); reject(abortError()); };
        signal.addEventListener('abort', onAbort, { once: true });
        button.addEventListener('click', () => {
          const now = performance.now();
          if (!this.frameHasFace || now - this.lastFaceAt > 350) {
            this.detail.textContent = '暫時看不到面部，請正望鏡頭，等待恢復後再按。';
            return;
          }
          if (now - lastClick < 160 || this.faceFrame === lastFrame) return;
          lastClick = now;
          lastFrame = this.faceFrame;
          this.wg.recordScreenPosition(x, y, 'click');
          count++;
          button.textContent = String(5 - count);
          this.detail.textContent = `望住圓點再按 · 此位置 ${count} / 5 次 · Esc 可取消`;
          if (count === 5) {
            signal.removeEventListener('abort', onAbort);
            button.remove();
            resolve();
          }
        });
      });
    }
  }

  async _validate(signal) {
    const targets = [[.3,.32],[.7,.32],[.5,.67],[.3,.72],[.72,.65]];
    const errors = [];
    for (let index = 0; index < targets.length; index++) {
      const [x, y] = targets[index].map((value, axis) => Math.round(value * (axis ? window.innerHeight : window.innerWidth)));
      const dot = this._dot(x, y, false);
      this.title.textContent = `精準度測試 ${index + 1} / ${targets.length}`;
      this.detail.textContent = '只用眼望住圓點，頭部保持不動。不需要按滑鼠。';
      await this._delay(850, signal);
      this.points = [];
      this.collecting = true;
      await this._delay(1500, signal);
      this.collecting = false;
      dot.remove();
      this._checkViewport();
      if (this.points.length < 6) throw new Error('測試時面部追蹤不穩定，未取得足夠資料。請改善光線後重新校準。');
      // Every target receives equal weight, regardless of the camera frame rate.
      errors.push(this.points.reduce((sum, p) => sum + Math.hypot(p.x - x, p.y - y), 0) / this.points.length);
    }
    return errors.reduce((sum, error) => sum + error, 0) / errors.length;
  }

  _overlay(signal) {
    this.previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'gaze-calibration';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '鏡頭校準');
    overlay.innerHTML = '<div class="gaze-calibration-copy"><span class="gaze-calibration-kicker">WEBCAM CALIBRATION · 實驗功能</span><h2></h2><p class="gaze-calibration-detail"></p><p class="gaze-calibration-privacy">鏡頭影像只在瀏覽器內處理；不會上傳或儲存。普通鏡頭未必能準確分辨每個字。</p></div><button class="gaze-calibration-close" type="button" aria-label="取消鏡頭校準">取消 · Esc</button>';
    document.body.append(overlay);
    this.overlay = overlay;
    this.title = overlay.querySelector('h2');
    this.detail = overlay.querySelector('.gaze-calibration-detail');
    const close = overlay.querySelector('.gaze-calibration-close');
    close.addEventListener('click', () => this.stop());
    close.focus();
    document.addEventListener('keydown', (event) => {
      if (!this.overlay) return;
      if (event.key === 'Escape') this.stop();
      if (event.key === 'Tab') {
        const buttons = [...overlay.querySelectorAll('button')];
        const next = (buttons.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
      }
    }, { signal });
  }

  _dot(x, y, interactive = true) {
    const dot = document.createElement(interactive ? 'button' : 'div');
    dot.className = `gaze-calibration-dot${interactive ? '' : ' gaze-validation-dot'}`;
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    if (interactive) {
      dot.type = 'button';
      dot.setAttribute('aria-label', '望住此點，按五次以校準');
    }
    this.overlay.append(dot);
    return dot;
  }

  _continue(label, signal) {
    return new Promise((resolve, reject) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gaze-calibration-continue';
      button.textContent = label;
      this.overlay.append(button);
      button.focus();
      const onAbort = () => { button.remove(); reject(abortError()); };
      signal.addEventListener('abort', onAbort, { once: true });
      button.addEventListener('click', () => {
        signal.removeEventListener('abort', onAbort);
        button.remove();
        resolve();
      }, { once: true });
    });
  }

  _status(state, message) {
    if (this.title && ['loading', 'permission', 'calibration', 'validation'].includes(state)) this.title.textContent = message;
    this.onStatus({ state, message });
  }

  _assert(signal) { if (signal.aborted) throw abortError(); }

  _checkViewport() {
    if (window.innerWidth !== this.calibrationViewport[0] || window.innerHeight !== this.calibrationViewport[1]) {
      throw new Error('視窗尺寸已改變，請重新校準。');
    }
  }

  _abortable(promise, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      const abort = () => reject(abortError());
      signal.addEventListener('abort', abort, { once: true });
      promise.then((result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      }, (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      });
    });
  }

  _delay(ms, signal) {
    return new Promise((resolve, reject) => {
      this._assert(signal);
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
      const cancel = () => { clearTimeout(timer); reject(abortError()); };
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  _releaseCamera() {
    clearInterval(this.healthTimer);
    this.collecting = false;
    this.lastFaceAt = -Infinity;
    this.lastPositions = null;
    this.frameHasFace = false;
    if (this.visibilityHandler) document.removeEventListener('visibilitychange', this.visibilityHandler);
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    if (!this.wg) return;
    this.wg.pause();
    this.wg.clearGazeListener();
    this.wg.removeMouseEventListeners();
    const video = document.getElementById('webgazerVideoFeed');
    video?.srcObject?.getTracks().forEach((track) => track.stop());
    try { this.wg.stopVideo(); } catch { /* camera may not have initialized */ }
    try { this.wg.end(); } catch { /* camera may not have initialized */ }
    this.wg.clearData();
  }

  stop() {
    this.controller?.abort();
    this._releaseCamera();
    this.overlay?.remove();
    this.overlay = null;
    this.phase = 'off';
    this.previousFocus?.focus?.();
    this._status('off', '鏡頭已關閉。');
  }

  destroy() {
    this.stop();
    window.removeEventListener('pagehide', this._pagehide);
  }
}
