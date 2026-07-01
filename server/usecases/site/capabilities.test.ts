import { beforeEach, describe, expect, it } from 'vitest'
import { getTranscodingCapabilities, setTranscodingCapabilities } from './capabilities'

describe('transcoding capabilities', () => {
  beforeEach(() => {
    // Reset to default state between tests
    setTranscodingCapabilities({ available: false })
  })

  it('defaults to unavailable with no version', () => {
    expect(getTranscodingCapabilities()).toEqual({ available: false })
  })

  it('reflects available with version after detection', () => {
    setTranscodingCapabilities({ available: true, ffmpegVersion: '7.0.2' })
    expect(getTranscodingCapabilities()).toEqual({
      available: true,
      ffmpegVersion: '7.0.2',
    })
  })

  it('reflects unavailable when ffmpeg is not installed', () => {
    setTranscodingCapabilities({ available: false })
    expect(getTranscodingCapabilities()).toEqual({ available: false })
  })
})
