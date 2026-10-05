import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')

const SIZE = 1024
// Apple's icon grid: the artwork fills 824 of the 1024 box and the rest stays
// clear, so the Dock renders Crew at the same visual weight as system apps.
const PLATE = 824
const INSET = (SIZE - PLATE) / 2
const CENTER = SIZE / 2
const RADIUS = PLATE / 2
const EXPONENT = 5

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
]

// The app's canvas: white at the top, settling into its lightest grey.
const PLATE_STOPS = [
  [0, hex('#FFFFFF')],
  [1, hex('#EBEBED')],
]
const PLATE_SHADOW = hex('#000000')
const CREW_SHADOW = hex('#2D2D38')
const EYE = hex('#0F172A')

// The crew: three bots in the colours of gaze, the faces the bots wear in
// the app, each taken one step deeper so it holds on white. The two at the
// sides look to the middle one, and it looks at you.
const PILLS = [
  { cx: 322, cy: CENTER, width: 150, height: 292, color: hex('#85BCF9'), look: 22 },
  { cx: 702, cy: CENTER, width: 150, height: 292, color: hex('#83D586'), look: -22 },
  { cx: CENTER, cy: CENTER, width: 190, height: 400, color: hex('#FBA962'), look: 0 },
]

// gaze's bean eyes, measured on the middle pill and scaled to the other two.
const EYES = PILLS.flatMap((pill) => {
  const scale = pill.width / 190
  const cx = pill.cx + pill.look * scale
  const cy = pill.cy - pill.height / 2 + (pill.look ? 150 : 140) * scale
  const gap = 78 * scale
  const eye = { cy, width: 34 * scale, height: 62 * scale }
  return [{ ...eye, cx: cx - gap / 2 }, { ...eye, cx: cx + gap / 2 }]
})

function rampAt(stops, t) {
  const clamped = Math.min(1, Math.max(0, t))
  for (let i = 1; i < stops.length; i++) {
    const [prevAt, prev] = stops[i - 1]
    const [nextAt, next] = stops[i]
    if (clamped > nextAt && i < stops.length - 1) continue
    const k = nextAt === prevAt ? 0 : (clamped - prevAt) / (nextAt - prevAt)
    return [
      prev[0] + (next[0] - prev[0]) * k,
      prev[1] + (next[1] - prev[1]) * k,
      prev[2] + (next[2] - prev[2]) * k,
    ]
  }
  return stops[0][1]
}

// Coverage from a signed distance in pixels: one pixel of linear falloff is the
// cheapest antialiasing that still holds up at the 16px Dock size.
const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance))

function plateDistance(x, y) {
  const nx = Math.abs((x - CENTER) / RADIUS)
  const ny = Math.abs((y - CENTER) / RADIUS)
  const power = nx ** EXPONENT + ny ** EXPONENT
  if (power === 0) return -RADIUS
  const field = power ** (1 / EXPONENT)
  // Normalising by the gradient turns the implicit superellipse into a usable
  // distance; without it the falloff width drifts around the corners.
  const gx = (EXPONENT * nx ** (EXPONENT - 1)) / RADIUS
  const gy = (EXPONENT * ny ** (EXPONENT - 1)) / RADIUS
  const slope = Math.sqrt(gx * gx + gy * gy) * (field ** (1 - EXPONENT) / EXPONENT)
  return slope === 0 ? -RADIUS : (field - 1) / slope
}

// A vertical pill: the crew's bodies and their eyes alike.
function pillDistance(x, y, pill) {
  const radius = pill.width / 2
  const dx = Math.abs(x - pill.cx) - (pill.width / 2 - radius)
  const dy = Math.abs(y - pill.cy) - (pill.height / 2 - radius)
  const ox = Math.max(dx, 0)
  const oy = Math.max(dy, 0)
  return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ox * ox + oy * oy) - radius
}

function boxBlur(source, radius) {
  const pass = (input) => {
    const output = new Float32Array(SIZE * SIZE)
    const span = radius * 2 + 1
    for (let y = 0; y < SIZE; y++) {
      const row = y * SIZE
      let sum = 0
      for (let x = -radius; x <= radius; x++) {
        sum += input[row + Math.min(SIZE - 1, Math.max(0, x))]
      }
      for (let x = 0; x < SIZE; x++) {
        output[row + x] = sum / span
        sum -= input[row + Math.min(SIZE - 1, Math.max(0, x - radius))]
        sum += input[row + Math.min(SIZE - 1, Math.max(0, x + radius + 1))]
      }
    }
    return output
  }
  const transpose = (input) => {
    const output = new Float32Array(SIZE * SIZE)
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) output[x * SIZE + y] = input[y * SIZE + x]
    }
    return output
  }
  let buffer = source
  for (let i = 0; i < 3; i++) buffer = transpose(pass(transpose(pass(buffer))))
  return buffer
}

const plateMask = new Float32Array(SIZE * SIZE)
const crewMask = new Float32Array(SIZE * SIZE)

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    plateMask[y * SIZE + x] = coverage(plateDistance(x + 0.5, y + 0.5))
    let mask = 0
    for (const pill of PILLS) {
      mask = Math.max(mask, coverage(pillDistance(x + 0.5, y + 0.5, pill)))
    }
    crewMask[y * SIZE + x] = mask
  }
}

const plateShadow = boxBlur(plateMask, 12)
const crewShadow = boxBlur(crewMask, 10)

// What a mask held `drop` pixels up: a shadow cast straight down lands here.
const dropped = (mask, x, y, drop) => (y >= drop ? mask[(y - drop) * SIZE + x] : 0)

// Straight-alpha "over": each layer lands on what the pixel already holds.
function paint(pixel, color, alpha) {
  if (alpha <= 0) return
  const below = pixel[3] * (1 - alpha)
  const total = alpha + below
  for (let c = 0; c < 3; c++) pixel[c] = (color[c] * alpha + pixel[c] * below) / total
  pixel[3] = total
}

const pixels = new Float32Array(SIZE * SIZE * 4)
const pixel = [0, 0, 0, 0]

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5
    const py = y + 0.5
    pixel.fill(0)

    // A white plate needs the shadow every macOS icon sits on to stay apart
    // from a light Dock; the crew casts a softer one onto the plate.
    paint(pixel, PLATE_SHADOW, dropped(plateShadow, x, y, 10) * 0.22)
    paint(pixel, rampAt(PLATE_STOPS, (py - INSET) / PLATE), plateMask[y * SIZE + x])
    paint(pixel, CREW_SHADOW, dropped(crewShadow, x, y, 8) * 0.18)
    for (const pill of PILLS) paint(pixel, pill.color, coverage(pillDistance(px, py, pill)))
    for (const eye of EYES) paint(pixel, EYE, coverage(pillDistance(px, py, eye)))

    const i = (y * SIZE + x) * 4
    pixels[i] = pixel[0]
    pixels[i + 1] = pixel[1]
    pixels[i + 2] = pixel[2]
    pixels[i + 3] = pixel[3] * 255
  }
}

function encodePng() {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < SIZE * 4; x++) {
      raw[row + 1 + x] = Math.round(Math.min(255, Math.max(0, pixels[y * SIZE * 4 + x])))
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'icon.png'), encodePng())

const iconset = join(out, 'icon.iconset')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset)
for (const size of [16, 32, 128, 256, 512]) {
  for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
    execFileSync('sips', [
      '-z', String(size * scale), String(size * scale),
      join(out, 'icon.png'),
      '--out', join(iconset, `icon_${size}x${size}${suffix}.png`),
    ], { stdio: 'ignore' })
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(out, 'icon.icns')])
rmSync(iconset, { recursive: true, force: true })

console.log('build/icon.png, build/icon.icns')
