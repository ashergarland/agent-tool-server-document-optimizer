import type { CapabilityContext } from '@agent-tool-platform/runtime/capability';
import { BoundedQueue } from '@agent-tool-platform/runtime/concurrency';
import { RootBoundary } from '@agent-tool-platform/runtime/fs';
import type { ScratchWorkspace } from '@agent-tool-platform/runtime/lifecycle';
import type { DocumentOptimizerConfig } from './config.js';
import { DocumentOptimizer } from './domain/document-optimizer.js';

export interface CapabilityServices {
  readonly optimizer: DocumentOptimizer;
  readonly boundary: RootBoundary;
  readonly queue: BoundedQueue;
  readonly scratch: ScratchWorkspace;
}

export const createCapabilityServices = async (
  context: CapabilityContext<DocumentOptimizerConfig>,
): Promise<CapabilityServices> => {
  const scratch = await context.createScratchWorkspace({ prefix: 'document-optimizer-' });
  const boundary = new RootBoundary({
    root: context.config.documents.root,
    requireRegularFile: true,
    maxFileBytes: context.config.documents.limits.maxSourceBytes,
  });
  const queue = new BoundedQueue(
    1,
    context.config.documents.limits.queueLimit,
    'document optimization work',
  );
  const optimizer = new DocumentOptimizer(
    context.config,
    boundary,
    queue,
    scratch.path,
    context.logger,
  );
  return { optimizer, boundary, queue, scratch };
};
