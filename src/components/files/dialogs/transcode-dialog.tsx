import type { TranscodingJobRequest } from '@shared/schemas/background-jobs'
import type { StorageObject } from '@shared/types'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { FileVideo, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createBackgroundJob } from '@/lib/api'
import { formatSize } from '@/lib/format'

type TargetFormat = TranscodingJobRequest['targetFormat']
type TargetResolution = TranscodingJobRequest['targetResolution']

const TWO_GB = 2 * 1024 * 1024 * 1024

interface TranscodeDialogProps {
  open: boolean
  items: StorageObject[]
  onOpenChange: (open: boolean) => void
}

export function TranscodeDialog({ open, items, onOpenChange }: TranscodeDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [format, setFormat] = useState<TargetFormat>('mp4')
  const [resolution, setResolution] = useState<TargetResolution>('original')
  const [submitted, setSubmitted] = useState(false)

  const hasLargeFiles = items.some((item) => item.size > TWO_GB)

  const mutation = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(
        items.map((item) =>
          createBackgroundJob({
            type: 'transcoding',
            matterId: item.id,
            targetFormat: format,
            targetResolution: resolution,
          }),
        ),
      )
      const succeeded = results.filter((r) => r.status === 'fulfilled').length
      const failed = results.filter((r) => r.status === 'rejected').length
      return { succeeded, failed, total: items.length }
    },
    onSuccess: ({ succeeded, failed, total }) => {
      setSubmitted(true)
      if (succeeded > 0) {
        toast.success(t('tasks.created'), {
          action: {
            label: t('tasks.viewTasks'),
            onClick: () => navigate({ to: '/tasks' }),
          },
        })
      }
      if (failed > 0) {
        toast.error(t('files.operationFailedSummary', { failed, total }))
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (items.length === 0 || mutation.isPending) return
    mutation.mutate()
  }

  if (submitted) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('files.transcodeTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">{t('tasks.created')}</p>
          </div>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>{t('share.done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('files.transcodeTitle')}</DialogTitle>
        </DialogHeader>
        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label>{t('files.transcodeSelectedFiles')}</Label>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/40 p-2">
              {items.map((item) => (
                <div key={item.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm">
                  <FileVideo className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatSize(item.size)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="transcode-format">{t('files.transcodeFormat')}</Label>
            <Select value={format} onValueChange={(v) => setFormat(v as TargetFormat)}>
              <SelectTrigger id="transcode-format" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mp4">MP4</SelectItem>
                <SelectItem value="webm">WebM</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="transcode-resolution">{t('files.transcodeResolution')}</Label>
            <Select value={resolution} onValueChange={(v) => setResolution(v as TargetResolution)}>
              <SelectTrigger id="transcode-resolution" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="original">{t('files.transcodeResolutionOriginal')}</SelectItem>
                <SelectItem value="1080p">1080p</SelectItem>
                <SelectItem value="720p">720p</SelectItem>
                <SelectItem value="480p">480p</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {hasLargeFiles && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t('files.transcodeLargeFileWarning')}</span>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={items.length === 0 || mutation.isPending}>
              {mutation.isPending ? t('common.loading') : t('files.transcodeSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
