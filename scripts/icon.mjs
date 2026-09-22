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

const PLATE_STOPS = [
  [0, hex('#FB8347')],
  [0.48, hex('#E2521F')],
  [1, hex('#B02C0D')],
]
const CREW_STOPS = [
  [0, hex('#FFFBF4')],
  [1, hex('#F2E6D4')],
]
const SHADOW = hex('#6B1A05')

const PILLS = [
  { cx: 328, width: 150, height: 292 },
  { cx: 696, width: 150, height: 292 },
  { cx: CENTER, width: 190, height: 400 },
]

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

function pillDistance(x, y, pill) {
  const radius = pill.width / 2
  const dx = Math.abs(x - pill.cx) - (pill.width / 2 - radius)
  const dy = Math.abs(y - CENTER) - (pill.height / 2 - radius)
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

const pixels = new Float32Array(SIZE * SIZE * 4)
const crewMask = new Float32Array(SIZE * SIZE)

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let mask = 0
    for (const pill of PILLS) {
      mask = Math.max(mask, coverage(pillDistance(x + 0.5, y + 0.5, pill)))
    }
    crewMask[y * SIZE + x] = mask
  }
}

const shadowMask = boxBlur(crewMask, 11)

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5
    const py = y + 0.5
    const i = (y * SIZE + x) * 4

    const distance = plateDistance(px, py)
    const plateAlpha = coverage(distance)
    if (plateAlpha <= 0 && crewMask[y * SIZE + x] <= 0) continue

    // Plate gradient, angled the way the SVG source describes it: top-left
    // highlight falling to a deep bottom-right.
    const t = ((px - INSET) * 0.35 + (py - INSET) * 1) / (PLATE * (0.35 * 0.35 + 1))
    let [r, g, b] = rampAt(PLATE_STOPS, t)

    const sheen = Math.max(0, 1 - (py - INSET) / (PLATE * 0.45)) * 0.26
    r += (255 - r) * sheen
    g += (255 - g) * sheen
    b += (255 - b) * sheen

    const rim = Math.max(0, 1 - Math.abs(distance + 1.5) / 1.5) * 0.18
    r += (255 - r) * rim
    g += (255 - g) * rim
    b += (255 - b) * rim

    let alpha = plateAlpha

    const shadow = (shadowMask[Math.min(SIZE - 1, y - 10) * SIZE + x] ?? 0) * 0.34
    if (shadow > 0) {
      r += (SHADOW[0] - r) * shadow
      g += (SHADOW[1] - g) * shadow
      b += (SHADOW[2] - b) * shadow
    }

    const crew = crewMask[y * SIZE + x]
    if (crew > 0) {
      const [cr, cg, cb] = rampAt(CREW_STOPS, (py - 312) / 400)
      const blended = alpha + crew * (1 - alpha)
      r = (r * alpha * (1 - crew) + cr * crew) / blended
      g = (g * alpha * (1 - crew) + cg * crew) / blended
      b = (b * alpha * (1 - crew) + cb * crew) / blended
      alpha = blended
    }

    pixels[i] = r
    pixels[i + 1] = g
    pixels[i + 2] = b
    pixels[i + 3] = alpha * 255
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
