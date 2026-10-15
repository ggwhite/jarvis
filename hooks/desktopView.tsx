import type { ElementConstructor, MarkdownProps, RenderElement } from 'claude-code'

import { HEALTH_TEXT, TABS } from './cockpit'
import type { Ctx, Ui } from './cockpit'
import { DT, LIGHT, backdropSvg } from './desktopTheme'
import { forDesktop } from './icons'
import { THEME } from './jarvis'
import type { Cockpit } from './jarvis'
import { cellPx, reactorSvg, rowPx, svgSafe } from './svgArt'
import type { JarvisPage } from '../types'

export type DesktopUi = Ui & { Markdown?: ElementConstructor<MarkdownProps> }

// The pages the native Desktop layout draws; every other page keeps drawCockpit.
export const DESKTOP_PAGES: readonly JarvisPage[] = ['now', 'stats']

// Whether the native layout draws this page: not while the boot screen plays.
export const desktopPage = (page: JarvisPage, ctx: Pick<Ctx, 'boot'>): boolean => ctx.boot === undefined && DESKTOP_PAGES.includes(page)

// The most rows a page is drawn for, whatever the room says.
const MAX_ROWS = 500

export function drawDesktop(ui: DesktopUi, view: Cockpit, ctx: Ctx): RenderElement {
  const { Box, Text, Button, Svg } = ui
  const cols = ctx.cols
  const rows = Number.isFinite(ctx.rows) && ctx.rows > 0 ? Math.min(ctx.rows, MAX_ROWS) : 40

  // a picture in whole cells and rows, or its words where it cannot go
  const picture = (source: string, alt: string, wide: number, tall: number, animated = false): RenderElement =>
    Svg && svgSafe(source) ? (
      <Svg source={source} alt={alt} width={cellPx(wide)} height={rowPx(tall)} {...(animated ? { isInteractive: true } : {})} />
    ) : (
      <Text color={DT.textSub}>{alt}</Text>
    )

  // an orange pill: a round box round a frameless button; solid for the current or main one
  const pill = (key: string, label: string, solid: boolean, onPress: () => void): RenderElement => (
    <Box borderStyle="round" borderColor={solid ? DT.orange500 : DT.orange200} backgroundColor={solid ? DT.orange500 : DT.orange50} paddingX={1}>
      <Button key={key} plain onPress={onPress}>
        <Text color={solid ? DT.onSolid : DT.orange700} bold={solid}>
          {label}
        </Text>
      </Button>
    </Box>
  )

  const live = view.running.length > 0
  const titleBar = (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text color={DT.orange900} bold>
          ⌜
        </Text>
        <Text color={THEME.suitRed} bold>
          J.A.R.V.I.S.
        </Text>
        <Text color={DT.orange900} bold>
          ⌝
        </Text>
        {picture(reactorSvg(live, LIGHT), live ? '反應爐運轉中' : '反應爐待機', 1, 1, live)}
      </Box>
      <Text color={view.health === 'ok' ? DT.orange700 : DT.fail} bold>
        {HEALTH_TEXT[view.health]}
      </Text>
    </Box>
  )

  const tabBar = (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {TABS.map(tab => pill(`tab-${tab.page}`, `${forDesktop(tab.icon)} ${tab.label}`, tab.page === ctx.page, () => ctx.go(tab.page)))}
    </Box>
  )

  // Task 3 and 4 fill these in
  const page: RenderElement = <Box flexDirection="column" gap={1} />
  ctx.onStandby?.(false)

  return (
    <Box flexDirection="column" position="relative" backgroundColor={DT.bg} minHeight={rows} paddingX={2} paddingY={1} gap={1}>
      {Svg ? (
        <Box position="absolute" top={0} left={0}>
          {picture(backdropSvg(cols, rows), '背景', cols, rows)}
        </Box>
      ) : null}
      {titleBar}
      {tabBar}
      {page}
    </Box>
  )
}
