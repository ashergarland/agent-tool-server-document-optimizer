import {
  defineAgentToolCapability,
  type CapabilityContext,
} from '@agent-tool-platform/runtime/capability';
import { readinessNotReady, readinessReady } from '@agent-tool-platform/runtime/lifecycle';
import {
  documentOptimizerConfigSpec,
  type DocumentOptimizerConfig,
  type documentOptimizerEnvSchema,
} from './config.js';
import { capabilityManifest } from './manifest.js';
import { createCapabilityServices, type CapabilityServices } from './services.js';
import { capabilityTools } from './tools/definitions.js';
import { capabilityInstructions } from './tools/guidance.js';

export const capability = defineAgentToolCapability<
  CapabilityServices,
  DocumentOptimizerConfig,
  typeof documentOptimizerEnvSchema
>({
  manifest: capabilityManifest,
  instructions: capabilityInstructions,
  config: documentOptimizerConfigSpec,
  tools: capabilityTools,

  createServices(context: CapabilityContext<DocumentOptimizerConfig>): Promise<CapabilityServices> {
    return createCapabilityServices(context);
  },

  readiness: [
    async ({ services }) => {
      const status = await services.boundary.status();
      return status.usable
        ? readinessReady('document_root')
        : readinessNotReady('document_root', status.reason ?? 'document_root_unusable');
    },
    ({ services }) => {
      const stats = services.queue.stats;
      const accepting =
        !stats.closed && (stats.active < stats.concurrency || stats.queued < stats.queueLimit);
      return accepting
        ? readinessReady('document_capacity')
        : readinessNotReady('document_capacity', 'document_optimization_queue_saturated');
    },
  ],

  lifecycle: {
    async stop({ services }) {
      await services.queue.drain();
    },
  },
});
