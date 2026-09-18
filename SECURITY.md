# Security

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not
open a public issue for an undisclosed vulnerability.

The only profile is local, filesystem-backed, and read-only. It requires no secrets. All source
paths are confined beneath `DOCUMENT_OPTIMIZER_ROOT`; Platform descriptor-bound reads prevent
symlink/reparse escape and path replacement races. PDF and DOCX parsing is bounded by source,
page/object, ZIP entry/uncompressed, compression-ratio, XML, media, text, result, queue, cache, and
time limits.

DOCX macro and embedded executable entries are never executed. Nested packages are not expanded,
external relationships are not fetched, XML document types/entities are rejected, and only
magic-byte-verified raster media is exported to private lifecycle scratch. Malformed or unsafe
documents fail with transport-safe errors.

Parser dependencies are pinned exactly. PDF.js is used directly for PDF structure; it invokes no
external executable. Its optional `@napi-rs/canvas` Node support package may contain native code,
but Document Optimizer does not render pages or pass document-controlled code to it. `yauzl`
performs lazy validated ZIP reads, and `saxes` parses bounded XML without resolving external
resources.

A future hosted, provider-backed, persistent, or mutating profile must be declared separately and
must preserve the shared security workflow gates.
