import { describe, expect, it, vi } from 'vitest'
import { healGatewayConnection, trustAuthenticatedGatewayConnection } from '../src/client.js'

describe('authenticated gateway client trust', () => {
  it('temporarily exposes loopback-only DSH surfaces to a paired gateway page', () => {
    const connection = { isLoopback: false }
    const restore = trustAuthenticatedGatewayConnection(connection)

    expect(connection.isLoopback).toBe(true)
    restore()
    expect(connection.isLoopback).toBe(false)
  })
})

describe('gateway connection recovery', () => {
  it('asks DSH to rebuild the connection instead of closing the multiplexer', () => {
    const reconnect = vi.fn()
    const heal = healGatewayConnection({ isLoopback: true, reconnect })

    expect(heal()).toBe(true)
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('reports that it could not recover when the handle has no reconnect', () => {
    const heal = healGatewayConnection({ isLoopback: true })

    expect(heal()).toBe(false)
  })

  it('swallows a reconnect that throws', () => {
    const heal = healGatewayConnection({
      isLoopback: true,
      reconnect: () => { throw new Error('generation is gone') },
    })

    expect(heal()).toBe(false)
  })
})
