export interface TranscodingCapabilities {
  available: boolean
  ffmpegVersion?: string
}

let transcodingCapabilities: TranscodingCapabilities = { available: false }

export function setTranscodingCapabilities(caps: TranscodingCapabilities): void {
  transcodingCapabilities = caps
}

export function getTranscodingCapabilities(): TranscodingCapabilities {
  return transcodingCapabilities
}
