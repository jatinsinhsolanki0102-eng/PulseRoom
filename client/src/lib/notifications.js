// Notification helpers: sound preference + an in-app notification chime
// generated with the Web Audio API (no audio asset required).

const SOUND_KEY = 'pulseroom_sound_enabled';

export function getSoundEnabled() {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch (e) {
    return true;
  }
}

export function setSoundEnabled(enabled) {
  try {
    localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off');
  } catch (e) {
    // ignore storage errors
  }
}

let audioCtx = null;

// Two-note "ding" (WhatsApp-style). Safe to call on any user gesture or
// incoming message; silently no-ops if audio is unavailable.
export function playNotificationSound() {
  if (!getSoundEnabled()) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    master.connect(ctx.destination);

    [880, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const t = now + i * 0.14;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(1, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  } catch (e) {
    // audio unavailable or blocked - ignore
  }
}
