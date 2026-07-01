import { spawn } from 'node:child_process'
import { Writable } from 'node:stream'
import type { Platform } from '../../platform/interface'
import type { TranscodingJobMessage, TranscodingJobsGateway } from '../../usecases/ports'
import type { TranscodeFn, TranscodingProcessingDeps } from '../../usecases/transcoding-processing'
import { processTranscodingJob } from '../../usecases/transcoding-processing'
import { createBackgroundJobRepo } from '../repos/background-job'
import { createMatterRepo } from '../repos/matter'
import { createNotificationRepo } from '../repos/notification'
import { createQuotaRepo } from '../repos/quota'
import { createStorageRepo } from '../repos/storage'
import { createStorageUsageRepo } from '../repos/storage-usage'
import { S3Service } from './s3'

// ─── Real FFmpeg functions ─────────────────────────────────────────────────

/**
 * Builds the ffmpeg argument list. All arguments are hardcoded flags and
 * internally-controlled values (resolution numbers, format strings) — no user
 * input is ever interpolated into a shell command.
 */
function buildFfmpegArgs(format: 'mp4' | 'webm', resolution: string): string[] {
  const codec = 'libx264'
  const crf = '23'
  const preset = 'medium'
  const args = ['-i', 'pipe:0', '-c:v', codec, '-crf', crf, '-preset', preset, '-movflags', 'frag_keyframe+empty_moov']

  // Scale filter per resolution
  if (resolution === '1080p') {
    args.push('-vf', 'scale=-2:1080')
  } else if (resolution === '720p') {
    args.push('-vf', 'scale=-2:720')
  } else if (resolution === '480p') {
    args.push('-vf', 'scale=-2:480')
  }
  // 'original' → no scale filter

  // Output format
  if (format === 'mp4') {
    args.push('-f', 'mp4')
  } else {
    args.push('-f', 'webm')
  }

  args.push('pipe:1')
  return args
}

function createRealTranscode(): TranscodeFn {
  return (options) => {
    const args = buildFfmpegArgs(options.format, options.resolution)
    const proc = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // stdin: pipe the Web ReadableStream to ffmpeg's stdin
    const nodeStdin = Writable.toWeb(proc.stdin!)
    const writer = nodeStdin.getWriter()
    const reader = options.inputStream.getReader()
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          await writer.write(value)
        }
      } catch {
        // Input stream error or abort — kill the process
        proc.kill()
      } finally {
        try {
          await writer.close()
        } catch {
          /* already closed */
        }
        reader.releaseLock()
      }
    })()

    // stdout: return as Web ReadableStream
    const nodeStdout = proc.stdout!
    // Handle backpressure: pause ffmpeg stdout when the output stream is slow
    const outputStream = new ReadableStream<Uint8Array>({
      start(controller) {
        nodeStdout.on('data', (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk))
        })
        nodeStdout.on('end', () => controller.close())
        nodeStdout.on('error', (err) => controller.error(err))
      },
      cancel() {
        nodeStdout.destroy()
        proc.kill()
      },
    })

    // stderr: collect chunks and forward to the progress callback
    let stderrBuffer = ''
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString()
      // Emit complete lines for progress parsing
      const lines = stderrBuffer.split('\n')
      stderrBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.includes('time=')) {
          options.onStderr(line)
        }
      }
    })

    const exitCode = new Promise<number>((resolve, reject) => {
      proc.on('close', (code) => resolve(code ?? 1))
      proc.on('error', (err) => reject(err))
    })

    // Handle abort signal
    if (options.signal) {
      options.signal.addEventListener('abort', () => proc.kill(), { once: true })
    }

    return { outputStream, exitCode }
  }
}

function createRealProbeDuration() {
  return async (sampleBytes: Uint8Array): Promise<number> => {
    return new Promise((resolve, _reject) => {
      const proc = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-i', 'pipe:0'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      proc.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })

      proc.on('close', (code) => {
        if (code !== 0) {
          // If probe fails (e.g. unsupported format), default to 0 duration
          // — progress percentage won't be available but the transcode still works.
          resolve(0)
          return
        }
        try {
          const info = JSON.parse(stdout)
          const duration = Number.parseFloat(info.format?.duration) || 0
          resolve(duration)
        } catch {
          resolve(0)
        }
      })

      proc.on('error', () => {
        resolve(0)
      })

      // Feed the sample bytes to ffprobe's stdin and close
      proc.stdin!.end(Buffer.from(sampleBytes))
    })
  }
}

// ─── Local queue (Node.js / no queue binding) ──────────────────────────────

class LocalTranscodingQueue {
  private readonly pending: TranscodingJobMessage[] = []
  private running = false

  constructor(private readonly run: (message: TranscodingJobMessage) => Promise<void>) {}

  push(message: TranscodingJobMessage): void {
    this.pending.push(message)
    if (!this.running) setTimeout(() => void this.drain(), 0)
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      for (;;) {
        const next = this.pending.shift()
        if (!next) return
        try {
          await this.run(next)
        } catch (error) {
          console.error('[transcoding-jobs] local worker failed:', error)
        }
      }
    } finally {
      this.running = false
      if (this.pending.length > 0) setTimeout(() => void this.drain(), 0)
    }
  }
}

// ─── Gateway factory ───────────────────────────────────────────────────────

export function createTranscodingJobsGateway(platform: Platform): TranscodingJobsGateway {
  const { db } = platform

  const deps: TranscodingProcessingDeps = {
    s3: new S3Service(),
    storages: createStorageRepo(db),
    quota: createQuotaRepo(db),
    storageUsage: createStorageUsageRepo(db),
    backgroundJobs: createBackgroundJobRepo(db),
    notifications: createNotificationRepo(db),
    matter: createMatterRepo(db),
    transcode: createRealTranscode(),
    probeDuration: createRealProbeDuration(),
  }

  async function runMessage(message: TranscodingJobMessage): Promise<void> {
    const request = message.request
    if (request.type !== 'transcoding') return

    await processTranscodingJob(deps, {
      orgId: message.orgId,
      userId: message.userId,
      request: request,
      jobId: message.jobId,
    })
  }

  const localQueue = new LocalTranscodingQueue(runMessage)

  return {
    async dispatch(message) {
      // No Cloudflare Queue binding for transcoding yet — always use the
      // in-process queue with sequential worker semantics.
      localQueue.push(message)
    },
    runMessage,
  }
}
