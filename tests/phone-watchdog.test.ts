import { describe, expect, it } from 'vitest'
import { chatStatusText, isHistoryStalled } from '../src/phone-watchdog.js'

/**
 * Stand-in for a chat flow node. Only the two things `chatStatusText` reads are
 * modelled: the direct children, and each child's class list and text.
 */
function fakeFlow(children: readonly { className?: string; textContent?: string }[]): Element {
  return {
    children: children.map((child) => ({
      className: child.className ?? '',
      textContent: child.textContent ?? '',
    })),
  } as unknown as Element
}

const HINT_SUFFIXES = ['_hint']

describe('chatStatusText', () => {
  it('reads the hint node rendered as a direct child of the flow', () => {
    const flow = fakeFlow([{ className: 'DwbCQq_hint', textContent: '载入历史…' }])
    expect(chatStatusText(flow, HINT_SUFFIXES)).toBe('载入历史…')
  })

  it('ignores a transcript that merely quotes the loading text', () => {
    // A message node is a direct child too, but its words live in descendants;
    // the old whole-flow scan matched this and reported a stall forever.
    const flow = fakeFlow([
      { className: 'DwbCQq_frame', textContent: '为什么手机端会出现「载入历史」的弹窗' },
      { className: 'DwbCQq_flowItem', textContent: '历史加载失败：{message}（{code}）' },
    ])
    expect(chatStatusText(flow, HINT_SUFFIXES)).toBe('')
  })

  it('ignores nodes whose class does not carry the status suffix', () => {
    const flow = fakeFlow([{ className: 'DwbCQq_older', textContent: '载入历史…' }])
    expect(chatStatusText(flow, HINT_SUFFIXES)).toBe('')
  })

  it('copes with an absent flow and with whitespace-only text', () => {
    expect(chatStatusText(null, HINT_SUFFIXES)).toBe('')
    expect(chatStatusText(fakeFlow([{ className: 'DwbCQq_hint', textContent: '   ' }]), ['_hint'])).toBe('')
  })
})

describe('isHistoryStalled', () => {
  it('fires only when the hint is up and the multiplexer has gone quiet', () => {
    expect(isHistoryStalled({ visible: true, hint: '载入历史…', idleMs: 8_000 })).toBe(true)
  })

  it('stays quiet while frames are still arriving', () => {
    expect(isHistoryStalled({ visible: true, hint: '载入历史…', idleMs: 2_000 })).toBe(false)
  })

  it('stays quiet when nothing is loading or the page is in the background', () => {
    expect(isHistoryStalled({ visible: true, hint: '', idleMs: 60_000 })).toBe(false)
    expect(isHistoryStalled({ visible: false, hint: '载入历史…', idleMs: 60_000 })).toBe(false)
  })
})
