import { DirType } from '@shared/constants'
import type { BackgroundJob } from '@shared/types'
import { buildObjectKey } from '../lib/path-template'
import type {
  BackgroundJobRepo,
  MatterRepo,
  NotificationRepo,
  QuotaRepo,
  S3Gateway,
  StorageRecord,
  StorageRepo,
  StorageUsageRepo,
} from './ports'
import { StorageQuotaExceededError, withStorageUsageReservation } from './storage-usage'

// ─── Types ─────────────────────────────────────────────────────────────────

export type TranscodeFormat = 'mp4' | 'webm'
export type TranscodeResolution = 'original' | '1080p' | '720p' | '480p'

export interface TranscodingJobInput {
  matterId: string
  targetFormat: TranscodeFormat
  targetResolution: TranscodeResolution
}

export interface TranscodeProcessOptions {
  inputStream: ReadableStream<Uint8Array>
  format: TranscodeFormat
  resolution: TranscodeResolution
  /** Called with each stderr chunk for progress parsing. */
  onStderr: (chunk: string) => void
  signal?: AbortSignal
}

export interface TranscodeProcessResult {
  outputStream: ReadableStream<Uint8Array>
  exitCode: Promise<number>
}

/**
 * Spawns an ffmpeg subprocess, piping the given input stream to stdin, and
 * returns the output stream + a promise for the exit code. The production
 * implementation uses child_process.spawn; tests inject a fake.
 */
export type TranscodeFn = (options: TranscodeProcessOptions) => TranscodeProcessResult

/**
 * Runs ffprobe on a sample of video bytes to extract the duration in seconds.
 * Production implementation uses child_process.spawn('ffprobe', ...); tests
 * inject a fake.
 */
export type ProbeDurationFn = (sampleBytes: Uint8Array) => Promise<number>

// ─── Deps ──────────────────────────────────────────────────────────────────

export interface TranscodingProcessingDeps {
  s3: S3Gateway
  storages: StorageRepo
  quota: QuotaRepo
  storageUsage: StorageUsageRepo
  backgroundJobs: BackgroundJobRepo
  notifications: NotificationRepo
  matter: MatterRepo
  transcode: TranscodeFn
  probeDuration: ProbeDurationFn
}

export interface RunTranscodingJobInput {
  orgId: string
  userId: string
  jobId: string
  request: TranscodingJobInput
  /** Overrides deps.s3 for tests. */
  s3?: S3Gateway
  /** Overrides deps.transcode for tests. */
  transcode?: TranscodeFn
  /** Overrides deps.probeDuration for tests. */
  probeDuration?: ProbeDurationFn
}

// ─── Constants ─────────────────────────────────────────────────────────────

const VIDEO_MIME_PREFIX = 'video/'
const PROGRESS_REPORT_INTERVAL_MS = 2000
/** First 8 MiB of a video is usually enough for ffprobe to determine the duration. */
const PROBE_BYTE_RANGE = 'bytes=0-8388608'

const MIME_BY_FORMAT: Record<TranscodeFormat, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
}

const EXT_BY_FORMAT: Record<TranscodeFormat, string> = {
  mp4: '.mp4',
  webm: '.webm',
}

function resolutionLabel(r: TranscodeResolution): string {
  return r === 'original' ? 'original' : r
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function processTranscodingJob(
  deps: TranscodingProcessingDeps,
  input: RunTranscodingJobInput,
): Promise<BackgroundJob> {
  const s3 = input.s3 ?? deps.s3
  const transcode = input.transcode ?? deps.transcode
  const probeDuration = input.probeDuration ?? deps.probeDuration

  try {
    await deps.backgroundJobs.update(input.orgId, input.jobId, {
      status: 'running',
      startedAt: new Date(),
    })

    // 1. Load source matter and validate it
    const sourceMatter = await deps.matter.get(input.request.matterId, input.orgId)
    if (sourceMatter?.status !== 'active' || sourceMatter.trashedAt != null) {
      throw new Error('Source file not found')
    }
    if (!sourceMatter.type.startsWith(VIDEO_MIME_PREFIX)) {
      throw new Error('Source file is not a video')
    }

    const sourceStorage = await requireStorage(deps, sourceMatter.storageId)

    // 2. Probe source duration for progress calculation.
    // Read only the first 8 MiB — enough for ffprobe to find the header.
    const probeBytes = await s3.getObjectBytes(sourceStorage, sourceMatter.object, PROBE_BYTE_RANGE)
    const sourceDuration = await probeDuration(probeBytes)

    await deps.backgroundJobs.update(input.orgId, input.jobId, {
      metadata: {
        matterId: input.request.matterId,
        targetFormat: input.request.targetFormat,
        targetResolution: input.request.targetResolution,
        sourceDuration,
      },
    })

    // 3. Build output file name
    const sourceNameNoExt = stripExtension(sourceMatter.name)
    const formatExt = EXT_BY_FORMAT[input.request.targetFormat]
    const outputName = `${sourceNameNoExt}_${resolutionLabel(input.request.targetResolution)}${formatExt}`
    const targetStorage = await deps.storages.select()
    const outputObjectKey = buildObjectKey({ uid: input.userId, orgId: input.orgId, rawExt: formatExt })

    // 4. Create draft output matter (not yet active — no quota charged yet)
    // The matter.create call may rename the output file if there's a name conflict
    // (onConflict: 'rename'), so use the returned matter's name going forward.
    const draftMatter = await deps.matter.create({
      orgId: input.orgId,
      name: outputName,
      type: MIME_BY_FORMAT[input.request.targetFormat],
      size: 0,
      dirtype: DirType.FILE,
      parent: sourceMatter.parent,
      object: outputObjectKey,
      storageId: targetStorage.id,
      status: 'draft',
      onConflict: 'rename',
    })
    const finalOutputName = draftMatter.name

    // 5. Transcode: S3 read stream → ffmpeg → S3 write stream
    const progressTracker = createTranscodingProgressTracker(deps, input.orgId, input.jobId, sourceDuration)

    const sourceStream = await s3.getObjectStream(sourceStorage, sourceMatter.object)
    let objectWritten = false
    let outputBytes = 0
    try {
      const transcodeResult = transcode({
        inputStream: sourceStream,
        format: input.request.targetFormat,
        resolution: input.request.targetResolution,
        onStderr: (chunk) => progressTracker.onStderrChunk(chunk),
      })

      outputBytes = await s3.putObject(
        targetStorage,
        outputObjectKey,
        transcodeResult.outputStream,
        MIME_BY_FORMAT[input.request.targetFormat],
      )
      objectWritten = true

      const exitCode = await transcodeResult.exitCode
      if (exitCode !== 0) {
        throw new Error(`ffmpeg exited with code ${exitCode}`)
      }

      // Final progress update
      await progressTracker.flush()

      // 6. Activate output matter and reserve quota
      const job = await withStorageUsageReservation(
        { quota: deps.quota, storageUsage: deps.storageUsage },
        { orgId: input.orgId, storageId: targetStorage.id, bytes: outputBytes },
        async (ctx) => {
          ctx.onRollback(async () => {
            await s3.deleteObject(targetStorage, outputObjectKey)
            await deps.matter.purge(input.orgId, [draftMatter.id])
          })

          const now = new Date()
          const activated = await deps.matter.activateDraft(draftMatter.id, input.orgId, finalOutputName, now)
          if (!activated) {
            throw new Error('Failed to activate output matter')
          }

          return deps.backgroundJobs.update(input.orgId, input.jobId, {
            status: 'completed',
            progress: {
              inputBytes: sourceMatter.size ?? 0,
              outputBytes,
              processedBytes: Math.round(sourceDuration),
              fileCount: 1,
              currentFilename: null,
            },
            resultMetadata: {
              matterId: draftMatter.id,
              outputName: finalOutputName,
              outputBytes,
            },
            cancelable: false,
            finishedAt: new Date(),
          })
        },
      )
      objectWritten = false

      // 7. Notify success
      await notifyTranscodingJobFinished(deps, job, sourceMatter.name, finalOutputName, draftMatter.id)
      return job
    } catch (error) {
      // 8. Cleanup on failure
      if (objectWritten) {
        await s3.deleteObject(targetStorage, outputObjectKey).catch(() => {})
      }
      await deps.matter.purge(input.orgId, [draftMatter.id]).catch(() => {})
      if (error instanceof StorageQuotaExceededError) {
        throw new Error('Storage quota exceeded for transcoded video')
      }
      throw error
    }
  } catch (error) {
    const failed = await deps.backgroundJobs.update(input.orgId, input.jobId, {
      status: 'failed',
      errorMessage: (error as Error).message,
      retryable: false,
      cancelable: false,
      finishedAt: new Date(),
    })
    await notifyTranscodingJobFinished(deps, failed, '', '', '').catch(() => {})
    return failed
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(0, dot) : name
}

async function requireStorage(
  deps: Pick<TranscodingProcessingDeps, 'storages'>,
  storageId: string,
): Promise<StorageRecord> {
  const storage = await deps.storages.get(storageId)
  if (!storage) throw new Error('Storage not found')
  return storage
}

// ─── Progress tracking ─────────────────────────────────────────────────────

/**
 * Parses ffmpeg stderr `time=HH:MM:SS.MS` lines and converts to progress
 * percentage. Updates the background job every PROGRESS_REPORT_INTERVAL_MS
 * to avoid write storms.
 */
function createTranscodingProgressTracker(
  deps: Pick<TranscodingProcessingDeps, 'backgroundJobs'>,
  orgId: string,
  jobId: string,
  totalDuration: number,
) {
  let lastReportedAt = 0
  let lastReportedSeconds = -1
  let latestSeconds = 0
  let running = false

  function parseTimeToSeconds(line: string): number | null {
    const match = line.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/)
    if (!match) return null
    const h = Number.parseInt(match[1], 10)
    const m = Number.parseInt(match[2], 10)
    const s = Number.parseInt(match[3], 10)
    const cs = Number.parseInt(match[4], 10)
    return h * 3600 + m * 60 + s + cs / 100
  }

  async function writeProgress(seconds: number): Promise<void> {
    if (totalDuration <= 0) return
    if (seconds === lastReportedSeconds) return
    lastReportedSeconds = seconds

    await deps.backgroundJobs.update(orgId, jobId, {
      progress: {
        inputBytes: 0,
        outputBytes: 0,
        processedBytes: Math.round(seconds),
        fileCount: 1,
        currentFilename: null,
      },
    })
  }

  return {
    onStderrChunk(chunk: string): void {
      const seconds = parseTimeToSeconds(chunk)
      if (seconds === null || seconds === latestSeconds) return
      latestSeconds = seconds

      const now = Date.now()
      if (now - lastReportedAt < PROGRESS_REPORT_INTERVAL_MS) return

      lastReportedAt = now
      // Serialise writes to avoid concurrent updates racing
      running = true
      void writeProgress(seconds).finally(() => {
        running = false
      })
    },
    async flush(): Promise<void> {
      // Wait for any in-flight write, then write the final value
      while (running) await new Promise((r) => setTimeout(r, 10))
      if (totalDuration > 0 && latestSeconds > 0) {
        await writeProgress(latestSeconds)
      }
    },
  }
}

// ─── Notifications ─────────────────────────────────────────────────────────

async function notifyTranscodingJobFinished(
  deps: Pick<TranscodingProcessingDeps, 'notifications'>,
  job: BackgroundJob,
  sourceName: string,
  outputName: string,
  outputMatterId: string,
): Promise<void> {
  const completed = job.status === 'completed'
  await deps.notifications.create({
    userId: job.userId,
    type: completed ? 'transcoding_job_completed' : 'transcoding_job_failed',
    title: completed ? 'Video transcoding completed' : 'Video transcoding failed',
    body: completed
      ? `${sourceName} → ${outputName} is ready.`
      : (job.errorMessage ?? `Transcoding of ${sourceName} failed.`),
    refType: completed ? 'matter' : 'background_job',
    refId: completed ? outputMatterId : job.id,
    metadata: JSON.stringify({
      jobId: job.id,
      jobType: job.type,
      status: job.status,
      sourceName,
      ...(completed ? { outputName, matterId: outputMatterId } : {}),
    }),
  })
}
