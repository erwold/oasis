/** The persisted message model (`runs.history_json`, HISTORY_FORMAT): the harness's own conversation record — a
 *  request / response split that is only ever appended to (what a provider received once is never rewritten, which
 *  is what its prompt cache needs), carries the compaction records (a request whose `compaction` field says the
 *  record before it was summarized into it), and names every provider-owned field (`provider_name`, signatures,
 *  ids) the handoff leaves out at the provider boundary. The field names are the ones the first backend stored, so
 *  histories written by either backend read back here. Unknown keys pass through: a part kind this build does not
 *  know is kept as data and rendered as a marker. */

import { z } from 'zod'
import { ImageAttachmentSchema, FileAttachmentSchema, FileRefAttachmentSchema } from './models.ts'

const Json: z.ZodType<unknown> = z.unknown()

/** An image in the conversation — attached to the person's words, or returned by the tool that reads a workspace
 *  file: an `ImageAttachment` (a session asset, content-addressed) with its kind. The history keeps the reference;
 *  only the request handed to a provider carries `data` (the bytes, base64), added at that moment. */
export const ImagePieceSchema = ImageAttachmentSchema.extend({ kind: z.literal('image'), data: z.string().optional() })
export type ImagePiece = z.infer<typeof ImagePieceSchema>
export const FilePieceSchema = FileAttachmentSchema.safeExtend({ kind: z.literal('file'), data: z.string().optional() })
export type FilePiece = z.infer<typeof FilePieceSchema>
/** A PDF / video reference in the conversation (`representation: 'ref-v1'`). The history keeps it as written; a
 *  request carries either its bytes (`data`, added at the provider boundary when the route takes it natively) or the
 *  one fixed line refFileNote renders from these fields — nothing else. */
export const RefFilePieceSchema = FileRefAttachmentSchema.safeExtend({ kind: z.literal('file'), data: z.string().optional() })
export type RefFilePiece = z.infer<typeof RefFilePieceSchema>
export type AttachmentPiece = ImagePiece | FilePiece | RefFilePiece

/** A user part's content: text, or a list of text and structured pieces (binary content is never stored: it is
 *  replaced by a placeholder string before the history is written). An attached image is an `ImagePiece`. */
export const UserContentSchema = z.union([z.string(), z.array(z.union([z.string(), z.record(z.string(), Json)]))])

export const UserPromptPartSchema = z.looseObject({
  part_kind: z.literal('user-prompt'),
  content: UserContentSchema,
  timestamp: z.string().optional(),
  /** who wrote it: the person (their message, with the app's context pieces named in app_pieces) or the app (a note,
   *  a continuation, a summary). Absent in records written before it was kept: read from the text then. */
  origin: z.enum(['person', 'app']).optional(),
  /** in a person's part whose content is a list: the indexes of the pieces the app wrote (the context before the task) */
  app_pieces: z.array(z.number().int().nonnegative()).optional(),
  /** a person's words sent while the run worked (contract/src/steering.ts): the steer's id; its content is the words
   *  exactly as sent, and no compaction cuts or summarizes them in the request it rides in or carries them in */
  steer_id: z.string().optional(),
})
export type UserPromptPart = z.infer<typeof UserPromptPartSchema>
export type UserContent = z.infer<typeof UserContentSchema>

export const SystemPromptPartSchema = z.looseObject({
  part_kind: z.literal('system-prompt'),
  content: z.string(),
  timestamp: z.string().optional(),
  dynamic_ref: z.string().nullable().optional(),
})
export type SystemPromptPart = z.infer<typeof SystemPromptPartSchema>

export const ToolReturnPartSchema = z.looseObject({
  part_kind: z.literal('tool-return'),
  tool_name: z.string(),
  content: Json,
  tool_call_id: z.string(),
  metadata: z.record(z.string(), Json).nullable().optional(),
  timestamp: z.string().optional(),
})
export type ToolReturnPart = z.infer<typeof ToolReturnPartSchema>

export const RetryPromptPartSchema = z.looseObject({
  part_kind: z.literal('retry-prompt'),
  content: z.union([z.string(), z.array(z.record(z.string(), Json))]),
  tool_name: z.string().nullable().optional(),
  tool_call_id: z.string().optional(),
  timestamp: z.string().optional(),
})
export type RetryPromptPart = z.infer<typeof RetryPromptPartSchema>

export const RequestPartSchema = z.discriminatedUnion('part_kind', [
  UserPromptPartSchema, SystemPromptPartSchema, ToolReturnPartSchema, RetryPromptPartSchema,
])
export type RequestPart = z.infer<typeof RequestPartSchema>

/** A compaction: the record before this request was summarized into it. `covers` is how many messages of the
 *  record it stands for (the messages before it, kept as they were for the person and the transcript); the model
 *  reads from this request on. `tokens_before` is the harness's estimate of what the model would have received,
 *  `summary_input_tokens` what the provider counted for the summary request. */
export const CompactionSchema = z.object({
  covers: z.number().int(),
  tokens_before: z.number().int().nullable(),
  summary_input_tokens: z.number().int().nullable(),
  model: z.string().nullable(),
  at: z.string(),
})
export type Compaction = z.infer<typeof CompactionSchema>

export const ModelRequestSchema = z.looseObject({
  kind: z.literal('request'),
  parts: z.array(RequestPartSchema),
  /** the system instructions of this request (the provider receives them once; the record repeats them) */
  instructions: z.string().nullable().optional(),
  /** set on a compaction request: the messages before it were summarized into its first part */
  compaction: CompactionSchema.optional(),
})
export type ModelRequest = z.infer<typeof ModelRequestSchema>

export const TextPartSchema = z.looseObject({
  part_kind: z.literal('text'),
  content: z.string(),
  id: z.string().nullable().optional(),
  provider_name: z.string().nullable().optional(),
  provider_details: z.record(z.string(), Json).nullable().optional(),
})
export type TextPart = z.infer<typeof TextPartSchema>

export const ThinkingPartSchema = z.looseObject({
  part_kind: z.literal('thinking'),
  content: z.string(),
  id: z.string().nullable().optional(),
  signature: z.string().nullable().optional(),
  provider_name: z.string().nullable().optional(),
  provider_details: z.record(z.string(), Json).nullable().optional(),
})
export type ThinkingPart = z.infer<typeof ThinkingPartSchema>

export const ToolCallPartSchema = z.looseObject({
  part_kind: z.literal('tool-call'),
  tool_name: z.string(),
  args: z.union([z.string(), z.record(z.string(), Json), z.null()]),
  tool_call_id: z.string(),
  id: z.string().nullable().optional(),
  provider_name: z.string().nullable().optional(),
  provider_details: z.record(z.string(), Json).nullable().optional(),
})
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>

/** A call of a tool the provider runs itself (its web search): made and answered inside one response, never run by
 *  the harness. `provider_details` holds the provider's own block, sent back to that provider as it came. */
export const BuiltinToolCallPartSchema = z.looseObject({
  part_kind: z.literal('builtin-tool-call'),
  tool_name: z.string(),
  args: z.union([z.string(), z.record(z.string(), Json), z.null()]),
  tool_call_id: z.string(),
  provider_name: z.string().nullable().optional(),
  provider_details: z.record(z.string(), Json).nullable().optional(),
})
export type BuiltinToolCallPart = z.infer<typeof BuiltinToolCallPartSchema>

/** What a provider's own tool returned (the search's results, or its error), in the same response as its call;
 *  `content` is what the person reads (titles and addresses), `provider_details` the provider's block as it came
 *  (with what only the provider can read, which it needs back to go on with the conversation). */
export const BuiltinToolReturnPartSchema = z.looseObject({
  part_kind: z.literal('builtin-tool-return'),
  tool_name: z.string(),
  tool_call_id: z.string(),
  content: Json,
  provider_name: z.string().nullable().optional(),
  provider_details: z.record(z.string(), Json).nullable().optional(),
})
export type BuiltinToolReturnPart = z.infer<typeof BuiltinToolReturnPartSchema>

/** A part kind this build does not know (a provider's native tool, a file): kept as data. */
export const ForeignPartSchema = z.looseObject({ part_kind: z.string() })
export type ForeignPart = z.infer<typeof ForeignPartSchema>

export const ResponsePartSchema = z.union([TextPartSchema, ThinkingPartSchema, ToolCallPartSchema, BuiltinToolCallPartSchema, BuiltinToolReturnPartSchema, ForeignPartSchema])
export type ResponsePart = TextPart | ThinkingPart | ToolCallPart | BuiltinToolCallPart | BuiltinToolReturnPart | ForeignPart

export const RequestUsageSchema = z.looseObject({
  input_tokens: z.number().int().optional(),
  cache_write_tokens: z.number().int().optional(),
  cache_read_tokens: z.number().int().optional(),
  output_tokens: z.number().int().optional(),
  input_audio_tokens: z.number().int().optional(),
  cache_audio_read_tokens: z.number().int().optional(),
  output_audio_tokens: z.number().int().optional(),
  details: z.record(z.string(), z.number()).optional(),
})
export type RequestUsage = z.infer<typeof RequestUsageSchema>

export const ModelResponseSchema = z.looseObject({
  kind: z.literal('response'),
  parts: z.array(ResponsePartSchema),
  usage: RequestUsageSchema.optional(),
  model_name: z.string().nullable().optional(),
  timestamp: z.string().optional(),
  provider_name: z.string().nullable().optional(),
  provider_details: z.record(z.string(), Json).nullable().optional(),
  provider_response_id: z.string().nullable().optional(),
  provider_url: z.string().nullable().optional(),
  finish_reason: z.string().nullable().optional(),
  run_id: z.string().nullable().optional(),
})
export type ModelResponse = z.infer<typeof ModelResponseSchema>

export const ModelMessageSchema = z.discriminatedUnion('kind', [ModelRequestSchema, ModelResponseSchema])
export type ModelMessage = z.infer<typeof ModelMessageSchema>
export const ModelMessagesSchema = z.array(ModelMessageSchema)
