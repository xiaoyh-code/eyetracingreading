// Only explicitly local voices are eligible; never silently select a cloud voice.
export function localEnglishVoice(voices = []) {
  const english = voices.filter(voice => voice.localService === true && /^en(?:[-_]|$)/i.test(voice.lang));
  return english.find(voice => /^en[-_]US$/i.test(voice.lang) && voice.default)
    ?? english.find(voice => /^en[-_]US$/i.test(voice.lang))
    ?? english.find(voice => voice.default) ?? english[0] ?? null;
}

export class PronunciationPlayer {
  constructor({ scope = globalThis, onStatus = () => {}, onAvailability = () => {} } = {}) {
    this.scope = scope;
    this.synth = scope.speechSynthesis;
    this.onStatus = onStatus;
    this.onAvailability = onAvailability;
    this.localAudioAvailable = false;
    this.sequence = 0;
    this.active = null;
    this.voicesChanged = () => onAvailability(this.availability());
    this.synth?.addEventListener('voiceschanged', this.voicesChanged);
  }

  voice() {
    try { return localEnglishVoice(this.synth?.getVoices()); } catch { return null; }
  }

  availability() {
    const available = !!(this.scope.SpeechSynthesisUtterance && this.voice()) || this.localAudioAvailable;
    return { available, message: available ? '本機英文發音 · 按喇叭播放' : '未找到本機英文聲音；請安裝英文語音或使用支援的瀏覽器。' };
  }

  setLocalAudioAvailable(value) {
    this.localAudioAvailable = Boolean(value);
    this.onAvailability(this.availability());
  }

  stop() {
    this.sequence++;
    const active = this.active;
    this.active = null;
    if (!active) return;
    clearTimeout(active.timer);
    active.abort?.abort();
    if (active.utterance) this.synth?.cancel();
    if (active.audio) { active.audio.pause(); active.audio.removeAttribute('src'); active.audio.load(); }
    if (active.url) this.scope.URL.revokeObjectURL(active.url);
    this.onStatus({ state: 'idle', word: active.word, sourceId: active.sourceId, message: '' });
  }

  async play(word, sourceId) {
    word = String(word ?? '').trim();
    if (this.active?.word === word && this.active.sourceId === sourceId) { this.stop(); return; }
    this.stop();
    if (!/^[A-Za-z]+(?:['’\-][A-Za-z]+)*$/.test(word) || word.length > 80) {
      this.onStatus({ state: 'error', sourceId, word, message: '請選擇一個英文單字播放。' });
      return;
    }
    const voice = this.voice();
    const active = this.active = { word, sourceId, sequence: this.sequence };
    const current = () => this.active === active;
    const notify = (state, message) => { if (current()) this.onStatus({ state, word, sourceId, message }); };
    const finish = (message = '') => {
      if (!current()) return;
      this.stop();
      if (message) this.onStatus({ state: 'error', word, sourceId, message });
    };
    active.timer = setTimeout(() => finish('發音準備逾時，請再按喇叭重試。'), 20000);
    notify('loading', '正在準備本機發音…');
    if (voice && this.scope.SpeechSynthesisUtterance) {
      const utterance = active.utterance = new this.scope.SpeechSynthesisUtterance(word);
      utterance.voice = voice;
      utterance.lang = voice.lang.replace('_', '-');
      utterance.rate = 0.85;
      utterance.onstart = () => notify('playing', '正在播放英文發音 · 再按可停止');
      utterance.onend = () => finish();
      utterance.onerror = () => finish('未能播放本機聲音，請檢查音訊輸出後重試。');
      try { this.synth.speak(utterance); } catch { finish('瀏覽器未能播放英文發音。'); }
      return;
    }
    if (!this.localAudioAvailable) { finish(this.availability().message); return; }
    active.abort = new AbortController();
    try {
      const response = await this.scope.fetch('/api/speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word }), signal: active.abort.signal,
      });
      if (!response.ok) throw new Error('local-audio-unavailable');
      const blob = await response.blob();
      if (!current()) return;
      active.url = this.scope.URL.createObjectURL(blob);
      active.audio = new this.scope.Audio(active.url);
      active.audio.onplaying = () => notify('playing', '正在播放英文發音 · 再按可停止');
      active.audio.onended = () => finish();
      active.audio.onerror = () => finish('聲音未能播放，請檢查音訊輸出後重試。');
      await active.audio.play();
    } catch {
      if (current()) finish('未能播放本機發音，請再按喇叭重試。');
    }
  }

  destroy() {
    this.stop();
    this.synth?.removeEventListener('voiceschanged', this.voicesChanged);
  }
}
