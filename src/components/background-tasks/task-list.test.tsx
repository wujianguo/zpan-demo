import type { BackgroundJob } from '@shared/types'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackgroundTaskList, formatTaskType, taskProgressPercent } from './task-list'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values?.count ? `${key}:${values.count}` : key),
  }),
}))

vi.mock('lucide-react', () => ({
  Archive: () => null,
  FileArchive: () => null,
  FileVideo: () => null,
  RotateCcw: () => null,
  Square: () => null,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    title,
  }: {
    children: React.ReactNode
    onClick?: React.MouseEventHandler
    disabled?: boolean
    title?: string
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  ),
}))

vi.mock('@/components/ui/progress', () => ({
  Progress: ({ value }: { value: number }) => <div data-testid="progress">{value}</div>,
}))

afterEach(cleanup)

describe('BackgroundTaskList', () => {
  it('renders queued, running, completed, and failed task states', () => {
    const jobs = [
      makeJob({ id: 'queued-job', status: 'queued' }),
      makeJob({ id: 'running-job', status: 'running', progress: { processedBytes: 50, inputBytes: 100 } }),
      makeJob({ id: 'completed-job', status: 'completed', resultMetadata: { outputName: 'files.zip' } }),
      makeJob({ id: 'failed-job', status: 'failed', errorMessage: 'ZIP paths cannot contain ..' }),
    ]

    const view = render(
      <BackgroundTaskList
        jobs={jobs}
        total={4}
        filter="active"
        onFilterChange={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(view.getByText('tasks.status.queued')).toBeTruthy()
    expect(view.getByText('tasks.status.running')).toBeTruthy()
    expect(view.getByText('tasks.status.completed')).toBeTruthy()
    expect(view.getByText('tasks.status.failed')).toBeTruthy()
    expect(view.getByText('files.zip')).toBeTruthy()
    expect(view.getAllByText('ZIP paths cannot contain ..')).toHaveLength(2)
  })

  it('calls retry and cancel handlers for actionable jobs', () => {
    const onCancel = vi.fn()
    const onRetry = vi.fn()
    const jobs = [
      makeJob({ id: 'running-job', status: 'running', cancelable: true }),
      makeJob({ id: 'failed-job', status: 'failed', retryable: true }),
    ]

    const view = render(
      <BackgroundTaskList
        jobs={jobs}
        total={2}
        filter="active"
        onFilterChange={vi.fn()}
        onCancel={onCancel}
        onRetry={onRetry}
      />,
    )

    fireEvent.click(view.getByTitle('tasks.cancel'))
    fireEvent.click(view.getByTitle('tasks.retry'))

    expect(onCancel).toHaveBeenCalledWith('running-job')
    expect(onRetry).toHaveBeenCalledWith('failed-job')
  })

  it('renders empty state', () => {
    const view = render(
      <BackgroundTaskList
        jobs={[]}
        total={0}
        filter="completed"
        onFilterChange={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(view.getByText('tasks.empty')).toBeTruthy()
  })
})

describe('taskProgressPercent', () => {
  it('returns completed jobs as 100%', () => {
    expect(taskProgressPercent(makeJob({ status: 'completed' }))).toBe(100)
  })

  it('computes running progress from processed and input bytes', () => {
    expect(taskProgressPercent(makeJob({ progress: { processedBytes: 25, inputBytes: 100 } }))).toBe(25)
  })
})

type JobOverrides = Omit<Partial<BackgroundJob>, 'progress'> & {
  progress?: Partial<BackgroundJob['progress']>
}

describe('formatTaskType', () => {
  const t = (key: string) => key

  it('returns correct label for transcoding', () => {
    expect(formatTaskType('transcoding', t)).toBe('tasks.type.transcoding')
  })

  it('returns correct label for archive_compress', () => {
    expect(formatTaskType('archive_compress', t)).toBe('tasks.type.archiveCompress')
  })

  it('falls back to raw type string for unknown types', () => {
    expect(formatTaskType('some_unknown_type', t)).toBe('some_unknown_type')
  })
})

describe('BackgroundTaskList — transcoding jobs', () => {
  it('renders transcoding job with correct type label and icon', () => {
    const jobs = [
      makeJob({
        id: 'transcode-job',
        type: 'transcoding',
        status: 'completed',
        resultMetadata: { matterId: 'matter-abc' },
      }),
    ]

    const view = render(
      <BackgroundTaskList
        jobs={jobs}
        total={1}
        filter="completed"
        onFilterChange={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(view.getByText('tasks.type.transcoding')).toBeTruthy()
    expect(view.getByText('tasks.status.completed')).toBeTruthy()
  })

  it('shows matterId in result for completed transcoding jobs', () => {
    const jobs = [
      makeJob({
        id: 'transcode-job',
        type: 'transcoding',
        status: 'completed',
        resultMetadata: { matterId: 'matter-abc-123' },
      }),
    ]

    const view = render(
      <BackgroundTaskList
        jobs={jobs}
        total={1}
        filter="completed"
        onFilterChange={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(view.getByText('matter-abc-123')).toBeTruthy()
  })
})

function makeJob(overrides: JobOverrides = {}): BackgroundJob {
  const { progress, ...jobOverrides } = overrides
  return {
    id: 'job-1',
    orgId: 'org-1',
    userId: 'user-1',
    type: 'archive_compress',
    status: 'queued',
    targetFolder: null,
    targetPath: null,
    metadata: null,
    progress: {
      inputBytes: 0,
      outputBytes: 0,
      processedBytes: 0,
      fileCount: 0,
      currentFilename: null,
      ...progress,
    },
    errorMessage: null,
    resultMetadata: null,
    retryable: false,
    cancelable: false,
    retriedFromJobId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...jobOverrides,
  }
}
