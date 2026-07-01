import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Validates that the Dockerfile's final runtime stage installs FFmpeg.
 * The final stage is the second `FROM node:24-slim` (the one without `AS builder`).
 * We find it by scanning the file for `FROM node:24-slim` lines and picking the last one.
 */
function findFinalStageAptInstall(): string | null {
  const dockerfilePath = resolve(import.meta.dirname ?? __dirname, '../../Dockerfile')
  const lines = readFileSync(dockerfilePath, 'utf-8').split('\n')

  // Find the last FROM node:24-slim line (the final stage, not the builder)
  let lastFromIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('FROM node:24-slim')) {
      // Skip the builder stage
      if (!lines[i].includes('AS builder')) {
        lastFromIndex = i
      }
    }
  }

  if (lastFromIndex === -1) return null

  // Scan the next 25 lines after the FROM for the apt-get install command
  for (let i = lastFromIndex + 1; i < Math.min(lastFromIndex + 26, lines.length); i++) {
    if (lines[i].includes('apt-get install')) {
      // Collect continuation lines (lines ending with \)
      let fullAptLine = lines[i]
      let j = i
      while (j + 1 < lines.length && lines[j].trimEnd().endsWith('\\')) {
        j++
        fullAptLine += ' ' + lines[j]
      }
      return fullAptLine
    }
  }

  return null
}

describe('Dockerfile (final stage)', () => {
  it('installs ffmpeg via apt-get in the final runtime stage', () => {
    const aptLine = findFinalStageAptInstall()

    expect(aptLine).not.toBeNull()

    // The apt-get install line must include ffmpeg
    expect(aptLine).toMatch(/\bffmpeg\b/)
  })
})
