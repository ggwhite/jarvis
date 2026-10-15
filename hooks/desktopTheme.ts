import { svgDoc } from './svgArt'
import type { Palette } from './svgArt'

// The native Desktop layout's tokens: Jarvis tech, glass, orange, light. The terminal keeps
// THEME; nothing here reaches it.
export const DT = {
  bg: '#FFF6EC',
  bgTo: '#F3E7DC',
  glass: '#FFFFFFB3',
  glassRaised: '#FFFFFFE0',
  glassBorder: '#FFB37A80',
  orange50: '#FFF4EA',
  orange200: '#FFD2A8',
  orange400: '#FF9A3C',
  orange500: '#FF7A1A',
  orange700: '#D95A00',
  orange900: '#8A3A00',
  data: '#5AC8FA',
  fail: '#E5484D',
  ok: '#2EA66B',
  text: '#1F2328',
  textSub: '#6B7280',
  textFaint: '#9CA3AF',
  onSolid: '#FFFFFF',
} as const

// the svgArt pictures in the light theme's quiet tones
export const LIGHT: Palette = { muted: DT.orange200, frame: DT.orange700, bright: DT.orange400, accent: DT.data }

// The pane's backdrop, `cols` cells by `rows` rows: warm white to pale orange-grey corner to
// corner, an orange glow top right, an ice glow bottom left, a faint 8pt dot grid. Static; only
// the size decides it.
export function backdropSvg(cols: number, rows: number): string {
  const defs =
    `<linearGradient id="bd-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${DT.bg}"/><stop offset="1" stop-color="${DT.bgTo}"/></linearGradient>` +
    `<radialGradient id="bd-glow" cx="0.85" cy="0.08" r="0.55"><stop offset="0" stop-color="${DT.orange400}" stop-opacity="0.35"/><stop offset="1" stop-color="${DT.orange400}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="bd-ice" cx="0.1" cy="0.92" r="0.5"><stop offset="0" stop-color="${DT.data}" stop-opacity="0.18"/><stop offset="1" stop-color="${DT.data}" stop-opacity="0"/></radialGradient>` +
    `<pattern id="bd-dots" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.6" fill="${DT.orange700}" fill-opacity="0.12"/></pattern>`
  const layers = ['bd-bg', 'bd-glow', 'bd-ice', 'bd-dots'].map(id => `<rect width="100%" height="100%" fill="url(#${id})"/>`).join('')
  return svgDoc(cols, rows, `<defs>${defs}</defs>${layers}`)
}
