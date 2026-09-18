# Document Optimizer

Document Optimizer is a local-first Agent Tool Platform capability that converts bounded PDF and
DOCX files into compact, deterministic, provenance-aware representations. An agent can inspect a
small manifest and extractive summary first, then request only the relevant outline entries,
section slices, tables, or figures.

It is not a whole-document-to-one-Markdown converter. It preprocesses a source once per process and
supports progressive access:

```text
source PDF / DOCX
        |
        v
manifest + extractive summary
        |
        v
paginated outline
        |
        v
one bounded section
        |
        +-- structured table rows
        |
        +-- figure metadata / source description
                 |
                 v
          raster bytes only when needed
```

The checked-in package version remains `0.0.0-development`. Stable tags are stamped only by the
shared Agent Tool Platform release workflow.

## Supported formats

### PDF

The PDF.js parser extracts:

- text with page and text-line provenance;
- page count and standard document metadata;
- bookmark matches and deterministic font-size heading clues;
- locally packaged predefined CMaps and standard-font data when PDF.js requires them;
- tagged PDF tables when table structure and marked-content IDs are available;
- an inventory of image paint operations, including page and dimensions when exposed.

The MVP does not perform OCR, page rendering, arbitrary layout reconstruction, or semantic image
analysis. A PDF with insufficient parser-visible text returns `needs-ocr` with an explicit warning
that OCR or Vision may be required. Untagged visual tables remain flattened page text rather than
being presented as reliable structured cells. PDF image occurrences are inventoried but not
exported as rendered assets.

### DOCX

The bounded OOXML parser extracts:

- headings, paragraphs, and basic list structure;
- source document properties;
- structural table headers, rows, and cells;
- embedded PNG, JPEG, GIF, or WebP media after magic-byte verification;
- source alt text, captions in the same paragraph, image dimensions, and relationship provenance.

DOCX macros, embedded executables, nested packages, and external relationships are never executed
or fetched. Unsupported or active image formats such as SVG/EMF/WMF are inventoried without
exporting bytes. Text-box content and OOXML compatibility fallback subtrees are skipped with
explicit warnings so ordinary paragraphs remain available and fallback copies are not duplicated.

## Tool surface

| Tool                   | Purpose                                                                                 | Normal cost                       |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------------------------- |
| `optimize_document`    | Validate and parse one root-relative PDF/DOCX into lifecycle-owned scratch              | One bounded preprocessing pass    |
| `inspect_document`     | Return manifest, deterministic extractive summary, counts, warnings, and fallback state | Cheapest orientation              |
| `get_document_outline` | Page through section hierarchy, short section summaries, and table/figure IDs           | Small structural result           |
| `get_document_section` | Read one bounded Markdown slice with block-level provenance                             | Targeted text                     |
| `get_document_table`   | Page through one table as structured rows, Markdown, or CSV text                        | Targeted structured data          |
| `get_document_figure`  | Read figure metadata first; optionally return bounded base64 raster bytes               | Metadata by default; bytes opt-in |

There is intentionally no corpus index or vector search. There is also no tool whose normal result
is the complete document.

## Agent-native representation

Each optimized package contains one deterministic JSON representation plus deduplicated raster
assets:

- `manifest`: source identity, SHA-256, format, metadata, parser status, extraction methods,
  warnings, counts, and optimized representation bytes;
- `summary`: a bounded deterministic/extractive overview, representative text, major headings, and
  limitations;
- `outline`: flat ordered hierarchy with parent IDs, page ranges, sizes, and table/figure links;
- `sections`: semantic Markdown and source-mapped content blocks;
- `tables`: headers, rows, extraction method, confidence, section link, and provenance;
- `figures`: media inventory, dimensions, source caption/alt text, asset state, and provenance;
- `documentMarkdown`: deterministic section composition for later ingestion.

IDs are derived deterministically. `documentId` incorporates the source-relative path, source
SHA-256, pipeline version, and capability version. Section, table, and figure IDs follow source
order. Generated content contains no processing timestamp or random identifier.

The package is held only for the current capability process. It is written atomically under a
Platform lifecycle-owned private scratch directory and removed on shutdown. Document Optimizer
does not claim durable persistence across process restarts. When the configured process cache count
is reached, further new optimizations return a bounded `limit_exceeded` error; restarting the local
process releases the cache.

## Provenance

Returned material remains traceable to the original source through:

- source-relative path and SHA-256;
- PDF page and text-line/operator/structure locator;
- DOCX archive entry and paragraph/table/drawing locator;
- heading path and section ID;
- block index and Markdown character range;
- table or figure ID;
- extraction method and confidence where meaningful.

Use raw/source tools when exact binary fidelity, a rendered original page, or unsupported parser
features are required.

## Vision and Doc RAG boundaries

Document Optimizer owns parsing, headings, text, sections, tables, figure extraction/inventory,
provenance, and progressive access. It preserves a future Vision handoff through media type,
dimensions, source descriptions, asset status, and optional verified raster bytes.

Vision owns semantic interpretation of images, diagrams, screenshots, and visual layouts.
Document Optimizer does not generate image meaning or require a Vision service.

Doc RAG owns retrieval across a corpus. The deterministic Markdown, sections, tables, identities,
and provenance produced here are suitable for later ingestion, but this capability does not build a
corpus, embedding index, or vector search service.

## Run locally

Node.js 22.13 or newer is required. Configure one explicit input boundary and launch the stdio
entrypoint:

```powershell
npm ci
npm run build
$env:DOCUMENT_OPTIMIZER_ROOT = 'C:\path\to\documents'
npm run mcp:stdio
```

Installed package:

```powershell
npx --package agent-tool-server-document-optimizer agent-tool-document-optimizer
```

The executable is a host-neutral MCP stdio endpoint. It binds no network listener and requires no
Azure subscription, cloud deployment, container, provider, credential, secret, or external model.
The package also exports its capability definition, tool catalogue, configuration helpers, model
schemas, and TypeScript model types.

## Configuration

All model-selected source paths must be relative to `DOCUMENT_OPTIMIZER_ROOT`.

| Environment variable                          |        Default | Absolute ceiling | Purpose                                |
| --------------------------------------------- | -------------: | ---------------: | -------------------------------------- |
| `DOCUMENT_OPTIMIZER_ROOT`                     | not configured |              n/a | Confined PDF/DOCX input directory      |
| `DOCUMENT_OPTIMIZER_MAX_SOURCE_BYTES`         |         25 MiB |          100 MiB | Source file limit                      |
| `DOCUMENT_OPTIMIZER_MAX_PDF_PAGES`            |            500 |            2,000 | PDF page limit                         |
| `DOCUMENT_OPTIMIZER_MAX_ARCHIVE_ENTRIES`      |          2,048 |           10,000 | DOCX ZIP entry limit                   |
| `DOCUMENT_OPTIMIZER_MAX_ARCHIVE_BYTES`        |        100 MiB |          512 MiB | Total declared uncompressed DOCX bytes |
| `DOCUMENT_OPTIMIZER_MAX_XML_BYTES`            |          8 MiB |           32 MiB | Individual parsed OOXML part limit     |
| `DOCUMENT_OPTIMIZER_MAX_FIGURE_BYTES`         |          4 MiB |           16 MiB | Individual exported raster limit       |
| `DOCUMENT_OPTIMIZER_MAX_EXTRACTED_CHARACTERS` |      2,000,000 |       10,000,000 | Parsed semantic text limit             |
| `DOCUMENT_OPTIMIZER_MAX_RESULT_CHARACTERS`    |        128,000 |        1,000,000 | Section/table result budget            |
| `DOCUMENT_OPTIMIZER_PROCESSING_TIMEOUT_MS`    |         30,000 |          300,000 | Parser operation deadline              |
| `DOCUMENT_OPTIMIZER_MAX_CACHED_DOCUMENTS`     |             16 |              128 | Process-lifetime package count         |
| `DOCUMENT_OPTIMIZER_QUEUE_LIMIT`              |              8 |              128 | Waiting optimization requests          |

The public JSON Schema is
[`schemas/local-configuration.schema.json`](schemas/local-configuration.schema.json).

## Filesystem and security boundary

Inputs are untrusted. Document Optimizer composes Platform `RootBoundary`, lifecycle scratch,
typed transport errors, cancellation, and a single-worker bounded queue with capability-specific
format and parser controls:

- relative paths only; no absolute, drive-relative, UNC, NUL, traversal, symlink/reparse escape, or
  final symlink;
- descriptor-bound source reads with open-time identity and byte-limit checks;
- PDF page, text-item, operator, table, figure, extracted-text, and timeout limits;
- DOCX entry-count, total-uncompressed-byte, XML-part, compression-ratio, nested-archive, table,
  paragraph, figure, and extracted-text limits;
- duplicate, encrypted, unsupported-compression, symbolic-link, and unsafe archive entries fail
  closed;
- XML document types and entity declarations are rejected;
- external relationships are not fetched and macro/embedded executable entries are ignored;
- raster assets are magic-byte checked and confined to private scratch;
- partial packages are removed and only atomically completed packages enter the in-memory index.

Malformed, unsupported, unsafe, oversized, and not-ready cases return explicit deterministic error
codes/messages. The source is never modified and callers cannot choose output paths.

## Deployment profile

[`capability-profiles.json`](capability-profiles.json) declares one
`local-filesystem-package` profile:

```text
execution=local
delivery=package
access=local-process
workload=filesystem
provider=none
mutation=read-only
```

`optimize_document` is a read tool. Its only writes are private, ephemeral implementation/cache
state under Platform scratch; it creates no durable or user-visible external state. See
[`docs/deployment-profiles.md`](docs/deployment-profiles.md).

## Validation

The comprehensive local checks are:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit
npm run metadata:validate
npm run package:smoke
npm audit --omit=dev --audit-level=high
git diff --check
```

Deployment contract v1 is validated against exact Platform revision
`98ec8162fb11d5c04aee9e6f7b3625a472a0180d`:

```powershell
$env:AGENT_TOOL_PLATFORM_CHECKOUT = 'C:\path\to\agent-tool-platform-at-98ec816'
npm run deployment:validate
npm run deployment:conformance
```

Tests use small generated synthetic fixtures for text PDF, recoverable PDF resource errors,
image-only PDF, headings, lists, text boxes, Unicode boundaries, escaped tables, embedded media,
malformed files, unsafe ZIP paths, compression bombs, nested archives, XML entities, resource
ceilings, determinism, and progressive retrieval. The Level 2 benchmark-derived DOCX proves
retention of runtime-contract, port, readiness, rollout/revision, and provenance facts.

## License

MIT
