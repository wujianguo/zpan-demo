import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { DirType } from '../../shared/constants'
import { createBackgroundJobRepo } from '../adapters/repos/background-job'
import { createMatterRepo } from '../adapters/repos/matter'
import { createNotificationRepo } from '../adapters/repos/notification'
import { createQuotaRepo } from '../adapters/repos/quota'
import { createStorageRepo } from '../adapters/repos/storage'
import { createStorageUsageRepo } from '../adapters/repos/storage-usage'
import { createTestApp } from '../test/setup.js'
import type { NotificationRepo, S3Gateway } from './ports'
import {
  type ProbeDurationFn,
  processTranscodingJob,
  type TranscodeFn,
  type TranscodeProcessOptions,
  type TranscodeProcessResult,
  type TranscodeResolution,
  type TranscodingProcessingDeps,
} from './transcoding-processing'

// ─── Test helpers ──────────────────────────────────────────────────────────

type TestDb = Awaited<ReturnType<typeof createTestApp>>['db']

const ORG_ID = 'transcoding-org'
const USER_ID = 'transcoding-user'
const STORAGE_ID = 'transcoding-storage'
const SOURCE_MATTER_ID = 'source-video'
const SOURCE_OBJECT_KEY = 'videos/demo.mp4'

function transcodingDeps(
  db: TestDb,
  overrides?: { transcode?: TranscodeFn; probeDuration?: ProbeDurationFn },
): TranscodingProcessingDeps {
  return {
    s3: undefined as unknown as S3Gateway,
    storages: createStorageRepo(db),
    quota: createQuotaRepo(db),
    storageUsage: createStorageUsageRepo(db),
    backgroundJobs: createBackgroundJobRepo(db),
    notifications: createNotificationRepo(db),
    matter: createMatterRepo(db),
    transcode:
      overrides?.transcode ??
      (() => {
        throw new Error('not implemented')
      }),
    probeDuration: overrides?.probeDuration ?? (() => Promise.resolve(60)),
  }
}

async function seedStorage(db: TestDb): Promise<void> {
  const now = Date.now()
  await db.run(sql`
    INSERT INTO storages (id, title, bucket, endpoint, region, access_key, secret_key, file_path, custom_host, capacity, used, status, created_at, updated_at)
    VALUES (${STORAGE_ID}, 'Transcode Storage', 'bucket', 'https://s3.example.com', 'auto', 'ak', 'sk', '', '', 0, 0, 'active', ${now}, ${now})
  `)
}

async function seedStoragePlanEntitlement(db: TestDb, orgId: string, bytes: number, id: string): Promise<void> {
  const now = Date.now()
  await db.run(sql`
    INSERT INTO org_quota_entitlements
      (id, org_id, resource_type, entitlement_type, source, source_id, bytes, starts_at, expires_at, status, metadata, created_at, updated_at)
    VALUES
      (${id}, ${orgId}, 'storage', 'plan', 'test', ${`${id}:${orgId}`}, ${bytes}, ${now}, NULL, 'active', '{"packageName":"Test Plan"}', ${now}, ${now})
  `)
}

async function seedVideoMatter(
  db: TestDb,
  opts?: { id?: string; name?: string; size?: number; mime?: string; status?: string; trashedAt?: number },
): Promise<void> {
  const now = Date.now()
  await db.run(sql`
    INSERT INTO matters (id, org_id, alias, name, type, size, dirtype, parent, object, storage_id, status, trashed_at, created_at, updated_at)
    VALUES (
      ${opts?.id ?? SOURCE_MATTER_ID}, ${ORG_ID},
      ${opts?.id ?? `${SOURCE_MATTER_ID}-alias`},
      ${opts?.name ?? 'demo.mp4'},
      ${opts?.mime ?? 'video/mp4'},
      ${opts?.size ?? 1024 * 1024},
      ${DirType.FILE},
      '',
      ${SOURCE_OBJECT_KEY},
      ${STORAGE_ID},
      ${opts?.status ?? 'active'},
      ${opts?.trashedAt ?? null},
      ${now}, ${now}
    )
  `)
}

async function seedMatter(
  db: TestDb,
  opts: { id: string; name: string; object: string; size: number; parent?: string; type?: string; status?: string },
): Promise<void> {
  const now = Date.now()
  await db.run(sql`
    INSERT INTO matters (id, org_id, alias, name, type, size, dirtype, parent, object, storage_id, status, trashed_at, created_at, updated_at)
    VALUES (${opts.id}, ${ORG_ID}, ${`${opts.id}-alias`}, ${opts.name}, ${opts.type ?? 'text/plain'}, ${opts.size}, ${DirType.FILE}, ${opts.parent ?? ''}, ${opts.object}, ${STORAGE_ID}, ${opts.status ?? 'active'}, NULL, ${now}, ${now})
  `)
}

async function seedJob(db: TestDb, id: string, metadata?: Record<string, unknown>): Promise<void> {
  const now = Date.now()
  await db.run(sql`
    INSERT INTO background_jobs (id, org_id, user_id, type, status, target_folder, target_path, metadata, input_bytes, output_bytes, processed_bytes, file_count, current_filename, error_message, result_metadata, retryable, cancelable, retried_from_job_id, created_at, updated_at, started_at, finished_at)
    VALUES (${id}, ${ORG_ID}, ${USER_ID}, 'transcoding', 'queued', NULL, NULL, ${metadata ? JSON.stringify(metadata) : null}, 0, 0, 0, 0, NULL, NULL, NULL, 0, 0, NULL, ${now}, ${now}, NULL, NULL)
  `)
}

async function seedOrgQuota(db: TestDb, used: number): Promise<void> {
  const period = new Date().toISOString().slice(0, 7) // YYYY-MM
  await db.run(sql`
    INSERT INTO org_quotas (id, org_id, quota, used, traffic_quota, traffic_used, traffic_period)
    VALUES ('quota-1', ${ORG_ID}, 1073741824, ${used}, 10737418240, 0, ${period})
  `)
}

// ─── Fake S3 ───────────────────────────────────────────────────────────────

class MemoryS3 {
  objects = new Map<string, Uint8Array>()
  putKeys: string[] = []
  deleteKeys: string[] = []

  async getObjectBytes(_storage: unknown, key: string, _range?: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key)
    if (!bytes) throw new Error(`Object not found: ${key}`)
    return bytes
  }

  async getObjectStream(_storage: unknown, key: string): Promise<ReadableStream<Uint8Array>> {
    const bytes = await this.getObjectBytes(_storage, key)
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  }

  async putObject(_storage: unknown, key: string, body: Uint8Array | ReadableStream): Promise<number> {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())
    this.objects.set(key, bytes)
    this.putKeys.push(key)
    return bytes.byteLength
  }

  async deleteObject(_storage: unknown, key: string): Promise<void> {
    this.deleteKeys.push(key)
    this.objects.delete(key)
  }
}

class FailingPutS3 extends MemoryS3 {
  override async putObject(): Promise<number> {
    throw new Error('S3 put failed')
  }
}

// ─── Fake transcode / probe ────────────────────────────────────────────────

function fakeTranscode(options: { outputBytes?: Uint8Array; stderrLines?: string[]; exitCode?: number }): TranscodeFn {
  return (opts: TranscodeProcessOptions): TranscodeProcessResult => {
    // Drain the input stream (simulate ffmpeg reading it)
    void opts.inputStream.getReader().read()

    // Emit stderr lines for progress parsing
    if (options.stderrLines) {
      for (const line of options.stderrLines) {
        opts.onStderr(line)
      }
    }

    const data = options.outputBytes ?? new Uint8Array([0x00, 0x01, 0x02])
    const outputStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data)
        controller.close()
      },
    })

    return {
      outputStream,
      exitCode: Promise.resolve(options.exitCode ?? 0),
    }
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('transcoding processing', () => {
  // ── Success path ─────────────────────────────────────────────────────────

  it('processes a video file end-to-end: transcode, activate matter, reserve quota, notify', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db)
    await seedStoragePlanEntitlement(db, ORG_ID, 100 * 1024 * 1024, 'plan-1')
    await seedJob(db, 'transcode-job-1')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024 * 1024)) // 1 MiB source

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({ outputBytes: new Uint8Array(512 * 1024) }),
        probeDuration: async () => 60.0,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'transcode-job-1',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    // Job completed
    expect(job).toMatchObject({ status: 'completed', type: 'transcoding' })
    expect(job.resultMetadata).toMatchObject({ outputName: 'demo_720p.mp4' })

    // Output matter is active
    const rows = await db.all<{ name: string; status: string; parent: string; dirtype: number }>(sql`
      SELECT name, status, parent, dirtype FROM matters
      WHERE org_id = ${ORG_ID} AND status = 'active' AND name = 'demo_720p.mp4'
    `)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ parent: '', dirtype: DirType.FILE, status: 'active' })

    // S3 write happened
    expect(s3.putKeys).toHaveLength(1)

    // Notification was created
    const notifRepo = createNotificationRepo(db) as NotificationRepo
    const notifs = await notifRepo.list(USER_ID, { page: 1, pageSize: 10 })
    expect(notifs.total).toBe(1)
    expect(notifs.items[0]).toMatchObject({
      type: 'transcoding_job_completed',
      title: 'Video transcoding completed',
    })
  })

  it('produces correct output file name: {name}_{resolution}.{ext} for each resolution', async () => {
    const cases: [TranscodeResolution, string][] = [
      ['original', 'demo_original.mp4'],
      ['1080p', 'demo_1080p.mp4'],
      ['720p', 'demo_720p.mp4'],
      ['480p', 'demo_480p.mp4'],
    ]

    for (const [resolution, expectedName] of cases) {
      const { db } = await createTestApp()
      await seedStorage(db)
      await seedVideoMatter(db, { name: 'demo.mp4' })
      await seedStoragePlanEntitlement(db, ORG_ID, 100 * 1024 * 1024, `plan-${resolution}`)
      await seedJob(db, `job-${resolution}`)

      const s3 = new MemoryS3()
      s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

      const job = await processTranscodingJob(
        transcodingDeps(db, {
          transcode: fakeTranscode({ outputBytes: new Uint8Array(512) }),
          probeDuration: async () => 60.0,
        }),
        {
          orgId: ORG_ID,
          userId: USER_ID,
          jobId: `job-${resolution}`,
          request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: resolution },
          s3: s3 as unknown as S3Gateway,
        },
      )

      expect(job.resultMetadata).toMatchObject({ outputName: expectedName })
      expect(job.status).toBe('completed')
    }
  })

  it('produces .webm output for webm format', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db)
    await seedStoragePlanEntitlement(db, ORG_ID, 100 * 1024 * 1024, 'plan-webm')
    await seedJob(db, 'job-webm')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({ outputBytes: new Uint8Array(512) }),
        probeDuration: async () => 60.0,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-webm',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'webm', targetResolution: '480p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.resultMetadata).toMatchObject({ outputName: 'demo_480p.webm' })
    expect(job.status).toBe('completed')
  })

  it('uses conflict rename when output name already exists', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db, { name: 'demo.mp4' })
    await seedStoragePlanEntitlement(db, ORG_ID, 100 * 1024 * 1024, 'plan-rename')
    // Create a file that will conflict with the output name
    await seedMatter(db, { id: 'existing-file', name: 'demo_720p.mp4', object: 'existing/obj', size: 100 })
    await seedJob(db, 'job-rename')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({ outputBytes: new Uint8Array(512) }),
        probeDuration: async () => 60.0,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-rename',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('completed')
    // The output should be renamed (e.g. "demo_720p (1).mp4")
    const name = job.resultMetadata?.outputName as string
    expect(name).toMatch(/^demo_720p/)
    expect(name).not.toBe('demo_720p.mp4') // original name would conflict
    // Active matter should exist with the renamed name
    const activeRows = await db.all<{ name: string }>(sql`
      SELECT name FROM matters WHERE org_id = ${ORG_ID} AND status = 'active' AND name = ${name}
    `)
    expect(activeRows).toHaveLength(1)
  })

  // ── Progress tracking ────────────────────────────────────────────────────

  it('tracks progress from ffmpeg stderr time= lines', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db)
    await seedStoragePlanEntitlement(db, ORG_ID, 100 * 1024 * 1024, 'plan-progress')
    await seedJob(db, 'job-progress')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024 * 1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({
          outputBytes: new Uint8Array(512 * 1024),
          stderrLines: [
            'frame=  100 fps=0.0 q=23.0 size=     100kB time=00:00:15.00 bitrate=  54.6kbits/s speed=0.5x',
            'frame=  200 fps=0.0 q=23.0 size=     200kB time=00:00:30.00 bitrate=  54.6kbits/s speed=0.5x',
            'frame=  400 fps=0.0 q=23.0 size=     400kB time=00:01:00.00 bitrate=  54.6kbits/s speed=0.5x',
          ],
        }),
        probeDuration: async () => 60.0,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-progress',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('completed')
    // Progress should reflect the last time= value (60 seconds)
    expect(job.progress.processedBytes).toBe(60)
  })

  it('stores source duration in job metadata', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db)
    await seedStoragePlanEntitlement(db, ORG_ID, 100 * 1024 * 1024, 'plan-meta')
    await seedJob(db, 'job-meta')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({ outputBytes: new Uint8Array(512) }),
        probeDuration: async () => 125.5,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-meta',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '1080p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.metadata).toMatchObject({
      sourceDuration: 125.5,
      targetFormat: 'mp4',
      targetResolution: '1080p',
      matterId: SOURCE_MATTER_ID,
    })
  })

  // ── Failure paths ────────────────────────────────────────────────────────

  it('fails when source matter does not exist', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedJob(db, 'job-missing')

    const s3 = new MemoryS3()

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({}),
        probeDuration: async () => 60,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-missing',
        request: { matterId: 'nonexistent', targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('failed')
    expect(job.errorMessage).toContain('not found')
  })

  it('fails when source matter is not a video MIME type', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db, { mime: 'application/octet-stream' })
    await seedJob(db, 'job-nonvideo')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({}),
        probeDuration: async () => 60,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-nonvideo',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('failed')
    expect(job.errorMessage).toContain('not a video')
  })

  it('fails when source matter is trashed', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db, { trashedAt: Date.now() })
    await seedJob(db, 'job-trashed')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({}),
        probeDuration: async () => 60,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-trashed',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('failed')
    expect(job.errorMessage).toContain('not found')
  })

  it('fails when ffmpeg exits with non-zero code and cleans up draft matter + S3 object', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db)
    await seedJob(db, 'job-ffmpeg-fail')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({ outputBytes: new Uint8Array(512), exitCode: 1 }),
        probeDuration: async () => 60,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-ffmpeg-fail',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('failed')
    expect(job.errorMessage).toContain('exited with code 1')

    // No active matter with the output name
    const activeRows = await db.all<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM matters WHERE org_id = ${ORG_ID} AND status = 'active' AND name LIKE 'demo_720p%'
    `)
    expect(activeRows[0].count).toBe(0)

    // No draft matter left behind
    const draftRows = await db.all<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM matters WHERE org_id = ${ORG_ID} AND status = 'draft'
    `)
    expect(draftRows[0].count).toBe(0)

    // S3 cleanup happened
    expect(s3.deleteKeys.length).toBeGreaterThanOrEqual(1)
  })

  it('cleans up when S3 putObject fails mid-transcode', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db)
    await seedJob(db, 'job-put-fail')

    const s3 = new FailingPutS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({ outputBytes: new Uint8Array(512) }),
        probeDuration: async () => 60,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-put-fail',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('failed')
    expect(job.errorMessage).toContain('S3 put failed')

    // No draft matter left
    const draftRows = await db.all<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM matters WHERE org_id = ${ORG_ID} AND status = 'draft'
    `)
    expect(draftRows[0].count).toBe(0)
  })

  it('sends failure notification with source filename and error reason', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db, { name: 'my-vacation.mp4' })
    await seedJob(db, 'job-notify-fail')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({ exitCode: 1 }),
        probeDuration: async () => 60,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-notify-fail',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('failed')

    const notifRepo = createNotificationRepo(db) as NotificationRepo
    const notifs = await notifRepo.list(USER_ID, { page: 1, pageSize: 10 })
    expect(notifs.total).toBe(1)
    expect(notifs.items[0]).toMatchObject({
      type: 'transcoding_job_failed',
      title: 'Video transcoding failed',
    })
    expect(notifs.items[0].body).toContain('exited with code 1')
  })

  // ── Quota reservation ────────────────────────────────────────────────────

  it('reserves quota for output file on success', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedOrgQuota(db, 0)
    await seedVideoMatter(db)
    await seedStoragePlanEntitlement(db, ORG_ID, 100 * 1024 * 1024, 'plan-quota')
    await seedJob(db, 'job-quota')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))
    const outputSize = 500 * 1024 // 500 KiB

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({ outputBytes: new Uint8Array(outputSize) }),
        probeDuration: async () => 60,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-quota',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('completed')
    expect(job.resultMetadata?.outputBytes).toBe(outputSize)

    // Verify usage was incremented
    const quotaRows = await db.all<{ used: number }>(sql`
      SELECT used FROM org_quotas WHERE org_id = ${ORG_ID}
    `)
    expect(quotaRows[0].used).toBe(outputSize)
  })

  it('releases quota on failure (S3 write error)', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedOrgQuota(db, 0)
    await seedVideoMatter(db)
    await seedStoragePlanEntitlement(db, ORG_ID, 100 * 1024 * 1024, 'plan-rel')
    await seedJob(db, 'job-rel')

    const s3 = new FailingPutS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({ outputBytes: new Uint8Array(500 * 1024) }),
        probeDuration: async () => 60,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-rel',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('failed')

    // Quota should not have been consumed
    const quotaRows = await db.all<{ used: number }>(sql`
      SELECT used FROM org_quotas WHERE org_id = ${ORG_ID}
    `)
    expect(quotaRows[0].used).toBe(0)
  })

  // ── stderr progress parsing ──────────────────────────────────────────────

  it('correctly parses time=HH:MM:SS.MS from ffmpeg stderr', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db)
    await seedStoragePlanEntitlement(db, ORG_ID, 100 * 1024 * 1024, 'plan-parse')
    await seedJob(db, 'job-parse')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

    // Simulate a 120-second video with progress updates
    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({
          outputBytes: new Uint8Array(1024),
          stderrLines: [
            'frame=   50 fps=0.0 q=23.0 time=00:00:30.00 bitrate=100.0kbits/s speed=0.5x',
            'frame=  100 fps=0.0 q=23.0 time=00:01:00.00 bitrate=100.0kbits/s speed=0.5x',
            'frame=  200 fps=0.0 q=23.0 time=00:02:00.00 bitrate=100.0kbits/s speed=0.5x',
          ],
        }),
        probeDuration: async () => 120.0,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-parse',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('completed')
    expect(job.progress.processedBytes).toBe(120) // last update: 2:00 = 120s
  })

  it('handles zero duration gracefully (progress remains 0)', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db)
    await seedStoragePlanEntitlement(db, ORG_ID, 100 * 1024 * 1024, 'plan-zero')
    await seedJob(db, 'job-zero')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({
          outputBytes: new Uint8Array(1024),
          stderrLines: ['time=00:00:10.00'],
        }),
        probeDuration: async () => 0,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-zero',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '720p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('completed')
    expect(job.progress.processedBytes).toBe(0)
  })

  it('output file is placed in the same parent directory as source', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)

    // Create source in a subfolder
    const now = Date.now()
    await db.run(sql`
      INSERT INTO matters (id, org_id, alias, name, type, size, dirtype, parent, object, storage_id, status, trashed_at, created_at, updated_at)
      VALUES ('source-sub', ${ORG_ID}, 'source-sub-alias', 'clip.mp4', 'video/mp4', 1024, ${DirType.FILE}, 'videos/sub', 'videos/sub/clip.mp4', ${STORAGE_ID}, 'active', NULL, ${now}, ${now})
    `)
    await seedStoragePlanEntitlement(db, ORG_ID, 100 * 1024 * 1024, 'plan-sub')
    await seedJob(db, 'job-sub')

    const s3 = new MemoryS3()
    s3.objects.set('videos/sub/clip.mp4', new Uint8Array(1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({ outputBytes: new Uint8Array(512) }),
        probeDuration: async () => 30,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-sub',
        request: { matterId: 'source-sub', targetFormat: 'mp4', targetResolution: '1080p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('completed')

    const rows = await db.all<{ name: string; parent: string }>(sql`
      SELECT name, parent FROM matters WHERE org_id = ${ORG_ID} AND status = 'active' AND name = 'clip_1080p.mp4'
    `)
    expect(rows).toHaveLength(1)
    expect(rows[0].parent).toBe('videos/sub')
  })

  // ── Notification content ─────────────────────────────────────────────────

  it('notification on success contains source name, output name, and file ref', async () => {
    const { db } = await createTestApp()
    await seedStorage(db)
    await seedVideoMatter(db, { name: 'sunset.mp4' })
    await seedStoragePlanEntitlement(db, ORG_ID, 100 * 1024 * 1024, 'plan-notify')
    await seedJob(db, 'job-notify-ok')

    const s3 = new MemoryS3()
    s3.objects.set(SOURCE_OBJECT_KEY, new Uint8Array(1024))

    const job = await processTranscodingJob(
      transcodingDeps(db, {
        transcode: fakeTranscode({ outputBytes: new Uint8Array(512) }),
        probeDuration: async () => 60,
      }),
      {
        orgId: ORG_ID,
        userId: USER_ID,
        jobId: 'job-notify-ok',
        request: { matterId: SOURCE_MATTER_ID, targetFormat: 'mp4', targetResolution: '1080p' },
        s3: s3 as unknown as S3Gateway,
      },
    )

    expect(job.status).toBe('completed')

    const notifRepo = createNotificationRepo(db) as NotificationRepo
    const notifs = await notifRepo.list(USER_ID, { page: 1, pageSize: 10 })
    expect(notifs.items[0]).toMatchObject({
      type: 'transcoding_job_completed',
      refType: 'matter',
    })
    expect(notifs.items[0].body).toContain('sunset')
    expect(notifs.items[0].body).toContain('sunset_1080p.mp4')
  })
})
