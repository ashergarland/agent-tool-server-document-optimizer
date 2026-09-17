import { fileURLToPath } from 'node:url';
import {
  createAgentToolApplication,
  type AgentToolApplication,
} from '@agent-tool-platform/runtime';
import { createSilentLogger } from '@agent-tool-platform/runtime/logging';
import { generateTestApiKey } from '@agent-tool-platform/testkit';
import { capability } from '../../src/capability.js';
import type { DocumentOptimizerConfig } from '../../src/config.js';
import type { CapabilityServices } from '../../src/services.js';

export type TestApplication = AgentToolApplication<DocumentOptimizerConfig, CapabilityServices>;

export const fixturesRoot = fileURLToPath(new URL('../fixtures/documents/', import.meta.url));

const apiKey = generateTestApiKey();

export const createTestApplication = async (
  overrides: NodeJS.ProcessEnv = {},
  start = false,
): Promise<TestApplication> => {
  const application = await createAgentToolApplication(capability, {
    logger: createSilentLogger(),
    env: {
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: apiKey,
      DOCUMENT_OPTIMIZER_ROOT: fixturesRoot,
      ...overrides,
    },
    readinessCacheMs: 0,
  });
  if (start) await application.start();
  return application;
};

export const signal = (): AbortSignal => new AbortController().signal;
