import { svgDoc } from './svgArt'
import type { Palette } from './svgArt'

// The native Desktop layout's tokens: Apple-style dark glass with orange lines and words. The
// terminal keeps THEME; nothing here reaches it.
export const DT = {
  bg: '#0B0D12',
  bgTo: '#141824',
  glass: '#FFFFFF0F',
  glassRaised: '#FFFFFF14',
  glassBorder: '#FFFFFF24',
  pillBg: '#FFFFFF0A',
  orange: '#FF9F0A',
  orangeBright: '#FFB340',
  orangeEdge: '#FF9F0A99',
  orangeLine: '#FF9F0A66',
  orangeFill: '#FF9F0A33',
  blue: '#0A84FF',
  data: '#64D2FF',
  fail: '#FF453A',
  ok: '#30D158',
  text: '#F5F5F7',
  textSub: '#A1A1A6',
  textFaint: '#6E6E73',
} as const

// the svgArt pictures on dark glass: grey tracks, orange sights, ice core
export const GLASS: Palette = { muted: '#3A3A3C', frame: DT.orange, bright: '#FFD60A', accent: DT.data }

// The pane's backdrop, `cols` cells by `rows` rows: charcoal to navy top to bottom, leaning
// right, an orange glow top right, a blue glow bottom left, a faint 8pt dot grid. Static; only
// the size decides it.
export function backdropSvg(cols: number, rows: number): string {
  const defs =
    `<linearGradient id="bd-bg" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="${DT.bg}"/><stop offset="1" stop-color="${DT.bgTo}"/></linearGradient>` +
    `<radialGradient id="bd-glow" cx="0.85" cy="0.08" r="0.55"><stop offset="0" stop-color="${DT.orange}" stop-opacity="0.18"/><stop offset="1" stop-color="${DT.orange}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="bd-ice" cx="0.1" cy="0.92" r="0.5"><stop offset="0" stop-color="${DT.blue}" stop-opacity="0.12"/><stop offset="1" stop-color="${DT.blue}" stop-opacity="0"/></radialGradient>` +
    `<pattern id="bd-dots" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.6" fill="#FFFFFF" fill-opacity="0.04"/></pattern>`
  const layers = ['bd-bg', 'bd-glow', 'bd-ice', 'bd-dots'].map(id => `<rect width="100%" height="100%" fill="url(#${id})"/>`).join('')
  return svgDoc(cols, rows, `<defs>${defs}</defs>${layers}`)
}
