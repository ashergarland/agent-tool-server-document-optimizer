import type { CapabilityManifest } from '@agent-tool-platform/runtime/capability';
import packageManifest from '../package.json' with { type: 'json' };

export const capabilityManifest: CapabilityManifest = {
  name: 'agent-tool-server-template',
  version: packageManifest.version,
  title: 'Thin Capability Template',
  description:
    'Read-only local text metrics demonstrating the thin Agent Tool Platform capability shape.',
  documentationUrl: 'https://github.com/ashergarland/agent-tool-server-template#readme',
};
