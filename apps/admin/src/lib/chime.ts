/**
 * The support alert sound: two short tones made with Web Audio, so there is no asset to ship.
 * Browsers keep audio locked until the user interacts with the page: the banner calls
 * unlockChime() on the first pointer press anywhere. Until then playChime() is silent and
 * chimeReady() is false, which the banner tells the user.
 */
let ctx: AudioContext | null = null;

function audioContextClass(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function unlockChime(): void {
  const Ctor = audioContextClass();
  if (!Ctor) return;
  try {
    ctx = ctx ?? new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

export function chimeReady(): boolean {
  return ctx?.state === 'running';
}

export function playChime(): void {
  const c = ctx;
  if (!c || c.state !== 'running') return;
  const now = c.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    const start = now + i * 0.22;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.21);
  });
}
