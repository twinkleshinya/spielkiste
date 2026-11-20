/** Coarse short-time spectrum for conspicuous whistle/chirp contours.
 * A UI suitability guard; this does not attempt semantic sound recognition. */
export function hasPronouncedPitchSweep(wav: Buffer) {
  if (wav.toString("ascii", 0, 4) !== "RIFF") return false;
  let offset = 12, data = -1, size = 0, rate = 16000, channels = 1, bits = 16;
  while (offset + 8 <= wav.length) {
    const length = wav.readUInt32LE(offset + 4), kind = wav.toString("ascii", offset, offset + 4);
    if (kind === "fmt " && length >= 16) { channels = wav.readUInt16LE(offset + 10); rate = wav.readUInt32LE(offset + 12); bits = wav.readUInt16LE(offset + 22); }
    if (kind === "data") { data = offset + 8; size = Math.min(length, wav.length - data); break; }
    offset += 8 + length + length % 2;
  }
  if (data < 0 || channels !== 1 || bits !== 16 || rate < 12000) return false;
  const samples = Math.min(Math.floor(size / 2), Math.round(rate * .8)), n = 512, hop = 64;
  const contours: { hz: number; strength: number; time: number }[] = [];
  const frequencies = Array.from({ length: Math.floor((Math.min(7600, rate / 2 - 100) - 1500) / 125) + 1 }, (_, k) => 1500 + 125 * k);
  const coeff = frequencies.map(hz => 2 * Math.cos(2 * Math.PI * hz / rate));
  const window = Float64Array.from({ length: n }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (n - 1)));
  for (let start = 0; start + n <= samples; start += hop) {
    const frame = Float64Array.from(window, (w, i) => w * wav.readInt16LE(data + 2 * (start + i)) / 32768);
    const powers = coeff.map(c => { let a = 0, b = 0; for (const x of frame) { const s = x + c * a - b; b = a; a = s; } return Math.max(0, a * a + b * b - c * a * b); });
    const total = powers.reduce((a, b) => a + b, 0), max = Math.max(...powers), index = powers.indexOf(max);
    contours.push({ hz: frequencies[index], strength: total > 1e-5 && max / total > .11 ? max : 0, time: start / rate });
  }
  const loudest = Math.max(0, ...contours.map(p => p.strength));
  const tonal = contours.filter(p => p.strength > loudest * .025 && p.strength > 1e-5);
  if (tonal.length < 8 || tonal.at(-1)!.time - tonal[0].time < .055) return false;
  const sorted = tonal.map(p => p.hz).sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * .1)], high = sorted[Math.floor(sorted.length * .9)];
  const distinct = new Set(tonal.map(p => Math.round(p.hz / 250)));
  const moving = tonal.slice(1).filter((p, i) => p.time - tonal[i].time < .009 && Math.abs(p.hz - tonal[i].hz) >= 125 && Math.abs(p.hz - tonal[i].hz) <= 875).length;
  return high - low > 2500 && high / low > 1.8 && distinct.size >= 8 && moving >= 5;
}
