import type { TranscodingJobMessage, TranscodingJobsGateway } from '../../usecases/ports'

// Stub gateway — transcoding dispatch won't be reachable until the
// transcoding request type is added to the discriminated union in
// shared/schemas/background-jobs.ts. When it is, replace this with a
// real implementation (similar to createArchiveJobsGateway).
export function createTranscodingJobsGateway(): TranscodingJobsGateway {
  return {
    async dispatch(_message: TranscodingJobMessage): Promise<void> {
      throw new Error('TranscodingJobsGateway.dispatch not yet implemented')
    },
    async runMessage(_message: TranscodingJobMessage): Promise<void> {
      throw new Error('TranscodingJobsGateway.runMessage not yet implemented')
    },
  }
}
