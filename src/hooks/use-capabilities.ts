import { useQuery } from '@tanstack/react-query'
import { getCapabilities } from '@/lib/api'

export const capabilitiesQueryKey = ['site', 'capabilities'] as const

export function useCapabilities() {
  const { data, isLoading, isError } = useQuery({
    queryKey: capabilitiesQueryKey,
    queryFn: getCapabilities,
    staleTime: 5 * 60 * 1000,
  })

  return {
    available: data?.transcoding.available ?? false,
    ffmpegVersion: data?.transcoding.ffmpegVersion,
    isLoading,
    isError,
  }
}
