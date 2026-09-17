import {
  defineAgentToolCapability,
  type AgentToolCapability,
} from '@agent-tool-platform/runtime/capability';
import { TextInspector, type CapabilityServices } from './domain/text-inspector.js';
import { capabilityManifest } from './manifest.js';
import { capabilityTools } from './tools/definitions.js';
import { capabilityInstructions } from './tools/guidance.js';

export const capability: AgentToolCapability<CapabilityServices> = defineAgentToolCapability({
  manifest: capabilityManifest,
  instructions: capabilityInstructions,
  tools: capabilityTools,

  createServices(): CapabilityServices {
    return { text: new TextInspector() };
  },
});
