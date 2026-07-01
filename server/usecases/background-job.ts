// The background-jobs resource usecase (/api/background-jobs). Owns every
// port call behind the routes: enqueue + dispatch on create, the list/get/cancel
// reads, and the retry-then-redispatch flow that re-parses a job's stored request
// so a fresh attempt rides the correct job pipeline.
//
// BackgroundJobError is thrown by the repo (not_found / not_cancelable /
// not_retryable) and propagates through these functions untouched; the http
// handler catches it and maps the code to a status. Org/user resolution stays in
// the handler as input parsing.

import type { CreateBackgroundJobRequest } from '@shared/schemas'
import { createBackgroundJobRequestSchema } from '@shared/schemas'
import type { BackgroundJob } from '@shared/types'
import type { Deps } from './deps'
import type { ListBackgroundJobsOptions } from './ports'

type ListResult = { items: BackgroundJob[]; total: number }

export function listBackgroundJobs(
  deps: Pick<Deps, 'backgroundJobs'>,
  orgId: string,
  opts: ListBackgroundJobsOptions,
): Promise<ListResult> {
  return deps.backgroundJobs.list(orgId, opts)
}

export function getBackgroundJob(
  deps: Pick<Deps, 'backgroundJobs'>,
  orgId: string,
  id: string,
): Promise<BackgroundJob> {
  return deps.backgroundJobs.get(orgId, id)
}

export function cancelBackgroundJob(
  deps: Pick<Deps, 'backgroundJobs'>,
  orgId: string,
  id: string,
): Promise<BackgroundJob> {
  return deps.backgroundJobs.cancel(orgId, id)
}

interface JobMessage {
  jobId: string
  orgId: string
  userId: string
  request: CreateBackgroundJobRequest
}

// Routes a job message to the correct gateway based on the request type.
// New job types register here — no other changes to this file needed.
function dispatchBackgroundJob(
  deps: Pick<Deps, 'archiveJobs' | 'transcodingJobs'>,
  message: JobMessage,
): Promise<void> {
  const type = message.request.type as string
  if (type === 'transcoding') {
    return deps.transcodingJobs.dispatch(message)
  }
  // archive_compress, archive_extract, and any future archive_* types
  return deps.archiveJobs.dispatch(message)
}

export async function createBackgroundJob(
  deps: Deps,
  params: { orgId: string; userId: string; request: CreateBackgroundJobRequest },
): Promise<BackgroundJob> {
  const { orgId, userId, request } = params
  const targetFolder = (request as { targetFolder?: string }).targetFolder ?? null
  const job = await deps.backgroundJobs.create({
    orgId,
    userId,
    type: request.type,
    targetFolder,
    metadata: request,
    cancelable: false,
  })
  await dispatchBackgroundJob(deps, { orgId, userId, request, jobId: job.id })
  return job
}

export async function retryBackgroundJob(
  deps: Pick<Deps, 'backgroundJobs' | 'archiveJobs' | 'transcodingJobs'>,
  orgId: string,
  id: string,
): Promise<BackgroundJob> {
  const job = await deps.backgroundJobs.retry(orgId, id)
  const request = createBackgroundJobRequestSchema.safeParse(job.metadata)
  if (request.success) {
    await dispatchBackgroundJob(deps, { orgId, userId: job.userId, request: request.data, jobId: job.id })
  }
  return job
}
