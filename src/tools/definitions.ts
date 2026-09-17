import { defineTool, type AnyToolDefinition } from '@agent-tool-platform/runtime/tools';
import { z } from 'zod';
import { countUnicodeCodePoints, type CapabilityServices } from '../domain/text-inspector.js';

const MAX_TEXT_CHARACTERS = 10_000;

const inspectTextInputSchema = z.object({
  text: z
    .string()
    .refine((value) => countUnicodeCodePoints(value) <= MAX_TEXT_CHARACTERS, {
      error: `Text must contain at most ${MAX_TEXT_CHARACTERS} Unicode code points`,
    })
    .meta({ maxLength: MAX_TEXT_CHARACTERS }),
});

const inspectTextOutputSchema = z.object({
  bytes: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
});

export type InspectTextInput = z.infer<typeof inspectTextInputSchema>;
export type InspectTextOutput = z.infer<typeof inspectTextOutputSchema>;

export const inspectTextTool = defineTool({
  name: 'inspect_text',
  title: 'Inspect text',
  summary: 'Count bytes, characters, lines, and words in supplied text.',
  description:
    'Measure the shape of caller-supplied text without storing it or interpreting its meaning.',
  kind: 'read',
  routing: {
    useWhen: ['you need byte, character, line, or word counts for text already supplied'],
    doNotUseWhen: [
      'you need a summary, translation, semantic analysis, file read, or state change; this capability does none of those',
    ],
    scope: 'at most 10,000 characters supplied directly in the call',
    changesState: false,
  },
  inputSchema: inspectTextInputSchema,
  outputSchema: inspectTextOutputSchema,
  handler(input, services: CapabilityServices) {
    return Promise.resolve(services.text.inspect(input.text));
  },
});

export const capabilityTools: readonly AnyToolDefinition<CapabilityServices>[] = [inspectTextTool];
