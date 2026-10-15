import type { EngineInterface } from 'claude-code'
import { lineOf } from './tasks'

// the small model that sums up a request and what it came to
export const SUMMARY_MODEL = 'haiku'
// how long one summary may take before it is given up
export const SUMMARY_TIMEOUT_MS = 15_000
// a prompt, and an answer, are cut to this many characters before they are sent
export const SUMMARY_INPUT_MAX = 2000
// a summary title and a result are kept to this many characters
export const SUMMARY_TITLE_MAX = 20
export const RESULT_MAX = 40
// the reply's token cap: one short line
export const SUMMARY_TOKENS = 100

export const SUMMARY_SYSTEM =
  '你替一個工作看板寫一行摘要。只回那一行繁體中文：不加引號、不加句號、不加「標題：」之類的前綴，也不解釋，也不用 → × — – 這類符號或彎引號。'

// a text cut to SUMMARY_INPUT_MAX characters
export const clipInput = (text: string): string => [...text].slice(0, SUMMARY_INPUT_MAX).join('')

// What a request asks for, the words its title is made from.
export const titleAsk = (prompt: string): string =>
  `用不超過 ${SUMMARY_TITLE_MAX} 個字寫出這個請求要做什麼，動詞開頭，例如「計算 7*6」「解釋 CAS」「修 jarvis 的高亮」。\n\n請求：\n${clipInput(prompt)}`

// What a request came to, from its prompt and its turn's answer.
export const resultAsk = (prompt: string, answer: string): string =>
  `用不超過 ${RESULT_MAX} 個字寫出這個請求的結果或結論，例如「42」「比較後交換的無鎖原子更新」「已合併進 master」。\n\n請求：\n${clipInput(prompt)}\n\n回答：\n${clipInput(answer)}`

// quotes and brackets around a reply, and a full stop after it
const WRAPS = /^["'「『“‘]+|["'」』”’]+$/g
const STOP = /[。.]+$/

// symbols that take two cells in an East Asian terminal, and the plain ones that stand in for them
const WIDE: [RegExp, string][] = [
  [/→/g, '->'],
  [/×/g, 'x'],
  [/[—–]/g, '-'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
]

// A reply as one line: its first non-blank line, unwrapped, cut to `max` characters.
export function cleanSummary(text: string, max: number): string {
  const plain = WIDE.reduce((t, [from, to]) => t.replace(from, to), text)
  const line = lineOf(plain, Number.MAX_SAFE_INTEGER).replace(STOP, '').replace(WRAPS, '').replace(STOP, '').trim()
  return lineOf(line, max)
}

// One summary from the small model, '' when there is none: refused, failed, cut off or empty.
export async function summarize($: Pick<EngineInterface, 'model'>, prompt: string, max: number): Promise<string> {
  try {
    const r = await $.model.complete({
      model: SUMMARY_MODEL,
      system: SUMMARY_SYSTEM,
      prompt,
      maxTokens: SUMMARY_TOKENS,
      effort: 'low',
      timeoutMs: SUMMARY_TIMEOUT_MS,
    })
    return r.isAnswered ? cleanSummary(r.text, max) : ''
  } catch {
    return ''
  }
}
