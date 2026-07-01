import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { Env } from '../../middleware/platform'
import { getTranscodingCapabilities } from '../../usecases/site/capabilities'
import { jsonContent } from '../openapi'

const transcodingCapabilitiesSchema = z.object({
  available: z.boolean().openapi({ example: true }),
  ffmpegVersion: z.string().optional().openapi({ example: '7.0.2' }),
})

const capabilitiesResponseSchema = z
  .object({
    transcoding: transcodingCapabilitiesSchema,
  })
  .openapi('SiteCapabilities')

const capabilitiesRoute = createRoute({
  operationId: 'getSiteCapabilities',
  summary: 'Get site capabilities',
  tags: ['Site'],
  method: 'get',
  path: '/',
  responses: {
    200: jsonContent(capabilitiesResponseSchema, 'Site capabilities'),
  },
})

const capabilities = new OpenAPIHono<Env>().openapi(capabilitiesRoute, (c) => {
  return c.json({ transcoding: getTranscodingCapabilities() }, 200)
})

export default capabilities
