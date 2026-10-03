import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The notification sounds, synthesized here so they are Crew's own and ship
// under its license. Run `node scripts/sounds.mjs` after changing one.
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'sounds')

const RATE = 22050

/**
 * One struck note: a sine with a few quieter partials, a short attack so it
 * does not click, and an exponential decay. `at` and `length` are seconds.
 */
function note(samples, { at, freq, length, gain, decay, partials = [] }) {
  const start = Math.round(at * RATE)
  const count = Math.round(length * RATE)
  const attack = Math.round(0.004 * RATE)
  for (let i = 0; i < count && start + i < samples.length; i += 1) {
    const t = i / RATE
    const envelope = Math.min(1, i / attack) * Math.exp(-t * decay)
    let value = Math.sin(2 * Math.PI * freq * t)
    for (const [ratio, weight] of partials) value += weight * Math.sin(2 * Math.PI * freq * ratio * t)
    samples[start + i] += gain * envelope * value
  }
}

function sound(seconds, notes) {
  const samples = new Float32Array(Math.round(seconds * RATE))
  for (const each of notes) note(samples, each)
  // The last few milliseconds fade to nothing, so no sound ends in a click.
  const tail = Math.round(0.02 * RATE)
  for (let i = 0; i < tail; i += 1) samples[samples.length - 1 - i] *= i / tail
  return samples
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((value, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const BELL = [[2, 0.18], [3, 0.06]]

const SOUNDS = {
  // A turn ended: two soft notes falling a fourth, over in half a second.
  chime: sound(0.6, [
    { at: 0, freq: 880, length: 0.6, gain: 0.22, decay: 7, partials: BELL },
    { at: 0.11, freq: 659.25, length: 0.49, gain: 0.22, decay: 6, partials: BELL },
  ]),
  // Waiting on you: brighter, rising, twice, so it is heard over music.
  ping: sound(0.7, [
    { at: 0, freq: 987.77, length: 0.3, gain: 0.3, decay: 10, partials: BELL },
    { at: 0.09, freq: 1318.51, length: 0.3, gain: 0.3, decay: 9, partials: BELL },
    { at: 0.32, freq: 987.77, length: 0.38, gain: 0.26, decay: 9, partials: BELL },
    { at: 0.41, freq: 1318.51, length: 0.29, gain: 0.26, decay: 8, partials: BELL },
  ]),
  // Something failed: low and falling, with an edge the others lack.
  alert: sound(0.55, [
    { at: 0, freq: 523.25, length: 0.25, gain: 0.26, decay: 9, partials: [[3, 0.25], [5, 0.1]] },
    { at: 0.16, freq: 392, length: 0.39, gain: 0.28, decay: 7, partials: [[3, 0.25], [5, 0.1]] },
  ]),
  // A bell from a terminal: one short tap.
  tap: sound(0.25, [{ at: 0, freq: 1174.66, length: 0.25, gain: 0.28, decay: 22, partials: BELL }]),
}

mkdirSync(out, { recursive: true })
for (const [name, samples] of Object.entries(SOUNDS)) writeFileSync(join(out, `${name}.wav`), wav(samples))
console.log(`wrote ${Object.keys(SOUNDS).length} sounds to ${out}`)
