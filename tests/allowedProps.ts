import type { Node } from './helpers'

// the only prop every element may carry
const COMMON = ['children']

// The props Claude Desktop's bundled Claude Code 2.1.295 accepts, read from its binary on
// 2026-10-15; one outside these and the whole pane is refused.
export const ALLOWED: Record<string, readonly string[]> = {
  Box: [
    'flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf', 'justifyContent',
    'gap', 'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight',
    'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
    'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
    'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow', 'display',
    'position', 'top', 'left', 'right', 'bottom',
  ],
  Text: ['color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'wrap'],
  Button: ['key', 'onPress', 'label', 'hotkey', 'action', 'plain', 'dimColor', 'variant', 'role', 'autoFocus'],
  Markdown: ['key', 'onLinkPress', 'text', 'dimColor', 'pressableLinks'],
  Svg: ['source', 'alt', 'width', 'height', 'isInteractive'],
}

// Every `Type.prop` in the tree outside ALLOWED, and every element type not in it, in tree order.
export function badProps(n: Node | string, out: string[] = []): string[] {
  if (typeof n === 'string') return out
  const type = n.type ?? ''
  const allowed = ALLOWED[type]
  if (!allowed) {
    out.push(type)
  } else {
    for (const k of Object.keys(n.props ?? {})) {
      if (COMMON.includes(k) || allowed.includes(k) || n.props?.[k] === undefined) continue
      // the engine echoes a bold Text as weight 'semibold'; any other weight is ours and refused
      if (type === 'Text' && k === 'weight' && n.props?.['bold'] === true && n.props?.['weight'] === 'semibold') continue
      out.push(`${type}.${k}`)
    }
  }
  for (const c of n.children ?? []) badProps(c, out)
  return out
}
