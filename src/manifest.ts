import type { CapabilityManifest } from '@agent-tool-platform/runtime/capability';
import packageManifest from '../package.json' with { type: 'json' };

export const capabilityManifest: CapabilityManifest = {
  name: 'agent-tool-server-document-optimizer',
  version: packageManifest.version,
  title: 'Document Optimizer',
  description:
    'Convert bounded local PDF and DOCX files into deterministic, provenance-aware representations for progressive agent access.',
  documentationUrl: 'https://github.com/ashergarland/agent-tool-server-document-optimizer#readme',
};
