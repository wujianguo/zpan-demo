import { describe, expect, it } from 'vitest'
import { createTestApp } from '../../test/setup'
import { setTranscodingCapabilities } from '../../usecases/site/capabilities'

describe('GET /api/site/capabilities', () => {
  it('returns transcoding unavailable when ffmpeg is not detected', async () => {
    setTranscodingCapabilities({ available: false })
    const { app } = await createTestApp()
    const res = await app.request('/api/site/capabilities')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ transcoding: { available: false } })
  })

  it('returns transcoding available with version when ffmpeg is detected', async () => {
    setTranscodingCapabilities({ available: true, ffmpegVersion: '7.0.2' })
    const { app } = await createTestApp()
    const res = await app.request('/api/site/capabilities')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ transcoding: { available: true, ffmpegVersion: '7.0.2' } })
  })

  it('is accessible without authentication', async () => {
    setTranscodingCapabilities({ available: false })
    const { app } = await createTestApp()
    // No auth headers — request as anonymous
    const res = await app.request('/api/site/capabilities')
    expect(res.status).toBe(200)
  })

  it('reflects a dynamically changed capabilities state', async () => {
    setTranscodingCapabilities({ available: false })
    const { app } = await createTestApp()

    let res = await app.request('/api/site/capabilities')
    expect((await res.json()) as { transcoding: { available: boolean } }).toEqual({
      transcoding: { available: false },
    })

    // Simulate ffmpeg becoming available
    setTranscodingCapabilities({ available: true, ffmpegVersion: '6.1.0' })
    res = await app.request('/api/site/capabilities')
    expect((await res.json()) as { transcoding: { available: boolean } }).toEqual({
      transcoding: { available: true, ffmpegVersion: '6.1.0' },
    })
  })
})
