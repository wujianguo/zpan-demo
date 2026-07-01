import type { CreateBackgroundJobRequest } from '@shared/schemas'

export interface TranscodingJobMessage {
  jobId: string
  orgId: string
  userId: string
  request: CreateBackgroundJobRequest
}

export interface TranscodingJobsGateway {
  // Hand a transcoding job off for asynchronous processing: a queue binding when
  // present, otherwise an in-process worker that drains on the next tick.
  dispatch(message: TranscodingJobMessage): Promise<void>
  // Process a single queued message synchronously (the queue consumer entrypoint).
  runMessage(message: TranscodingJobMessage): Promise<void>
}
