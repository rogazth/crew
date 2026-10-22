import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The notification sounds, synthesized here so they are Crew's own and ship
// under its license. Run `node scripts/sounds.mjs` after changing one.
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'sounds')

const RATE = 44100

/**
 * One pop: a sine whose pitch glides from `from` to `to` (Hz) over `glide`
 * seconds, a 2 ms attack so it does not click, and an exponential decay of
 * `decay` seconds. Partials are [ratio, weight]; a higher one dies sooner.
 * A one-pole low-pass takes the edge off. `at` and `length` are seconds.
 */
function pop(samples, { at = 0, from, to, glide, decay, length, partials = [[1, 1]], gain = 1, smooth = 0.35 }) {
  const start = Math.round(at * RATE)
  const count = Math.round(length * RATE)
  const attack = 0.002
  const phases = partials.map(() => 0)
  let filtered = 0
  for (let i = 0; i < count && start + i < samples.length; i += 1) {
    const t = i / RATE
    const freq = from * (to / from) ** Math.min(1, t / glide)
    let envelope = t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : 1
    envelope *= Math.exp(-t / decay) * Math.min(1, (length - t) / 0.01)
    let value = 0
    partials.forEach(([ratio, weight], j) => {
      phases[j] += (2 * Math.PI * freq * ratio) / RATE
      value += weight * Math.sin(phases[j]) * Math.exp(-t / (decay / Math.sqrt(ratio)))
    })
    filtered += smooth * (value * envelope - filtered)
    samples[start + i] += gain * filtered
  }
}

/** The pops laid over one another, then scaled so the loudest point is at `peak`. */
function sound(seconds, pops, peak = 0.5) {
  const samples = new Float32Array(Math.round(seconds * RATE))
  for (const each of pops) pop(samples, each)
  // The last few milliseconds fade to nothing, so no sound ends in a click.
  const tail = Math.round(0.01 * RATE)
  for (let i = 0; i < tail; i += 1) samples[samples.length - 1 - i] *= i / tail
  const loudest = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0) || 1
  return samples.map((value) => (value / loudest) * peak)
}

/** The same pop again, quieter, as if it bounced. */
function echoed(one) {
  return [one, { ...one, at: 0.11, gain: 0.38 }, { ...one, at: 0.22, gain: 0.14 }]
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

const KNOCK = [[1, 1], [2.01, 0.25]]

const SOUNDS = {
  // A turn ended: two soft pops falling, a close.
  "pop-down": sound(0.23, [
    { from: 640, to: 420, glide: 0.03, decay: 0.026, length: 0.12 },
    { at: 0.09, from: 480, to: 260, glide: 0.03, decay: 0.03, length: 0.14 },
  ]),
  // Waiting on you: two bubbles rising, a question.
  "pop-up": sound(0.205, [
    { from: 380, to: 700, glide: 0.035, decay: 0.026, length: 0.12 },
    { at: 0.085, from: 520, to: 980, glide: 0.035, decay: 0.026, length: 0.12 },
  ]),
  // Something failed: two low pops falling, heard without alarm.
  thud: sound(0.31, [
    { from: 320, to: 200, glide: 0.03, decay: 0.045, length: 0.16, partials: KNOCK },
    { at: 0.11, from: 250, to: 150, glide: 0.03, decay: 0.055, length: 0.2, partials: KNOCK },
  ]),
  // A bell from a terminal: one bubble and its bounces, soft enough to ring often.
  bubble: sound(0.42, echoed({ from: 320, to: 820, glide: 0.05, decay: 0.04, length: 0.2 })),
}

mkdirSync(out, { recursive: true })
for (const [name, samples] of Object.entries(SOUNDS)) writeFileSync(join(out, `${name}.wav`), wav(samples))
console.log(`wrote ${Object.keys(SOUNDS).length} sounds to ${out}`)
