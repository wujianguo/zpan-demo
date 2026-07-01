import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCapabilities } from './use-capabilities'

const useQueryMock = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-query', () => ({
  useQuery: useQueryMock,
}))

beforeEach(() => {
  useQueryMock.mockReset()
})

describe('useCapabilities', () => {
  it('returns available: true and version when ffmpeg is detected', () => {
    useQueryMock.mockReturnValue({
      data: { transcoding: { available: true, ffmpegVersion: '7.0.2' } },
      isLoading: false,
      isError: false,
    })

    expect(useCapabilities()).toEqual({
      available: true,
      ffmpegVersion: '7.0.2',
      isLoading: false,
      isError: false,
    })
  })

  it('returns available: false when ffmpeg is not detected', () => {
    useQueryMock.mockReturnValue({
      data: { transcoding: { available: false } },
      isLoading: false,
      isError: false,
    })

    expect(useCapabilities()).toEqual({
      available: false,
      ffmpegVersion: undefined,
      isLoading: false,
      isError: false,
    })
  })

  it('defaults to available: false while loading', () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    })

    expect(useCapabilities()).toEqual({
      available: false,
      ffmpegVersion: undefined,
      isLoading: true,
      isError: false,
    })
  })

  it('reports isError when query fails', () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    })

    expect(useCapabilities()).toEqual({
      available: false,
      ffmpegVersion: undefined,
      isLoading: false,
      isError: true,
    })
  })

  describe('capabilitiesQueryKey', () => {
    it('matches the expected shape ["site", "capabilities"]', async () => {
      const { capabilitiesQueryKey } = await import('./use-capabilities')

      expect(capabilitiesQueryKey).toEqual(['site', 'capabilities'])
    })
  })
})
