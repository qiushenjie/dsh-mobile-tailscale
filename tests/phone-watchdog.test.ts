import { describe, expect, it } from 'vitest'
import { chatStatusText, describeDownlinkFrame, describeOpenFrame, formatBytes, isHistoryStalled, keyRepairHint } from '../src/phone-watchdog.js'

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

describe('describeOpenFrame', () => {
  const follow = JSON.stringify({
    type: 'open',
    streamId: 'stream-1',
    endpoint: 'session/follow',
    payload: {
      args: {
        request: {
          address: { kind: 'session', sessionId: 'session-06ec1d65-bd9d-4f64-b243-01e716e63f35' },
          assistantStream: true,
          maxMessages: 10,
          turnWindow: { minMessages: 50, minTurns: 2 },
        },
      },
    },
  })

  it('reads the endpoint, stream and window of an open frame', () => {
    expect(describeOpenFrame(follow)).toStrictEqual({
      streamId: 'stream-1',
      endpoint: 'session/follow',
      detail: '[session-06ec1d65 max=10 turn=50/2 as=y]',
    })
  })

  it('names both sessions of a subagent address and tolerates an absent request', () => {
    const subagent = describeOpenFrame(JSON.stringify({
      type: 'open',
      streamId: 'stream-2',
      endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'subagent', parentSessionId: 'session-aa11', childSessionId: 'session-bb22' } } } },
    }))
    expect(subagent?.detail).toBe('[session-aa11/session-bb22 max=- turn=- as=-]')
    const bare = describeOpenFrame(JSON.stringify({ type: 'open', streamId: 's', endpoint: 'job/list' }))
    expect(bare).toStrictEqual({ streamId: 's', endpoint: 'job/list', detail: '' })
  })

  it('ignores uplink items, downlink frames and unparseable text', () => {
    expect(describeOpenFrame(JSON.stringify({ type: 'item', streamId: 's', value: {} }))).toBeNull()
    expect(describeOpenFrame(JSON.stringify({ type: 'open', endpoint: 'job/list' }))).toBeNull()
    expect(describeOpenFrame('{"type":"open"')).toBeNull()
    expect(describeOpenFrame(42)).toBeNull()
  })
})

describe('describeDownlinkFrame', () => {
  it('reports a snapshot with its record count and byte size', () => {
    const data = JSON.stringify({ type: 'item', streamId: 's1', value: { type: 'snapshot', records: [{}, {}, {}] } })
    expect(describeDownlinkFrame(data)).toStrictEqual({
      streamId: 's1',
      kind: 'snapshot',
      detail: ' rec=3',
      bytes: data.length,
    })
  })

  it('reports error codes and stream ends', () => {
    expect(describeDownlinkFrame(JSON.stringify({ type: 'error', streamId: 's1', error: { code: 'gateway/uplink-overflow', message: 'too slow' } }))?.kind).toBe('error')
    expect(describeDownlinkFrame(JSON.stringify({ type: 'error', streamId: 's1', error: { code: 'gateway/uplink-overflow', message: 'too slow' } }))?.detail).toBe(' gateway/uplink-overflow too slow')
    expect(describeDownlinkFrame(JSON.stringify({ type: 'end', streamId: 's1' }))).toStrictEqual({ streamId: 's1', kind: 'end', detail: '', bytes: 30 })
  })

  it('ignores uplink frames and text that is not a frame', () => {
    expect(describeDownlinkFrame(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'job/list' }))).toBeNull()
    expect(describeDownlinkFrame(JSON.stringify({ type: 'item', value: {} }))).toBeNull()
    expect(describeDownlinkFrame('not json')).toBeNull()
  })
})

describe('formatBytes', () => {
  it('keeps the sheet readable across four orders of magnitude', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(999)).toBe('999B')
    expect(formatBytes(279_501)).toBe('273.0K')
    expect(formatBytes(11_116_757)).toBe('10.6M')
  })
})

describe('keyRepairHint', () => {
  it('names the character, the code it was sent with, and whether the repair fired', () => {
    expect(keyRepairHint(10_000, [{ key: ' ', keyCodeUsed: 32, dispatched: true, at: 8_000 }])).toBe('" "→32 已补发@2s')
    expect(keyRepairHint(10_000, [{ data: '，', keyCodeUsed: 229, dispatched: false }])).toBe('"，"→229 未补发')
  })

  it('shows only the last four keys and stays silent with nothing to show', () => {
    const log = [1, 2, 3, 4, 5].map(index => ({ key: String(index), keyCodeUsed: 48 + index, dispatched: true }))
    expect(keyRepairHint(0, log).split('→')).toHaveLength(5)
    expect(keyRepairHint(0, log)).not.toContain('"1"')
    expect(keyRepairHint(0, [])).toBe('')
  })
})
