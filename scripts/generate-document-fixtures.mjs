import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import yazl from 'yazl';

const outputDirectory = fileURLToPath(new URL('../tests/fixtures/documents/', import.meta.url));
const fixedDate = new Date('2026-09-17T00:00:00.000Z');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/69a1WQAAAABJRU5ErkJggg==',
  'base64',
);

const xml = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const paragraph = (text, style) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${xml(style)}"/>` : ''}</w:pPr>` +
  `<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;

const listItem = (text, level = 0) =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="${String(level)}"/><w:numId w:val="1"/></w:numPr></w:pPr>` +
  `<w:r><w:t>${xml(text)}</w:t></w:r></w:p>`;

const table = (headers, rows) => {
  const row = (cells, header) =>
    `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells
      .map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`)
      .join('')}</w:tr>`;
  return `<w:tbl><w:tblPr/><w:tblGrid/>${row(headers, true)}${rows
    .map((cells) => row(cells, false))
    .join('')}</w:tbl>`;
};

const figureDrawing = (relationshipId, altText) =>
  `<w:drawing>` +
  `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
  `<wp:extent cx="952500" cy="476250"/>` +
  `<wp:docPr id="1" name="Synthetic figure" descr="${xml(altText)}"/>` +
  `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
  `<a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
  `<pic:blipFill><a:blip r:embed="${xml(
    relationshipId,
  )}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
  `</pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline>` +
  `</w:drawing>`;

const figureParagraph = (relationshipId, altText) =>
  `<w:p><w:r>${figureDrawing(relationshipId, altText)}</w:r></w:p>`;

const alternateFigureParagraph = (relationshipId, altText) =>
  `<w:p><w:r>` +
  `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
  `<mc:Choice Requires="wps">${figureDrawing(relationshipId, altText)}</mc:Choice>` +
  `<mc:Fallback><w:pict><v:imagedata xmlns:v="urn:schemas-microsoft-com:vml" ` +
  `r:id="${xml(
    relationshipId,
  )}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
  `</w:pict></mc:Fallback></mc:AlternateContent>` +
  `</w:r></w:p>`;

const textBoxParagraph = () =>
  `<w:p><w:r><w:t>Ordinary text before the shape.</w:t></w:r>` +
  `<w:r><w:drawing><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">` +
  `<wps:txbx><w:txbxContent>${paragraph(
    'Text-box content is outside the bounded MVP parser.',
  )}</w:txbxContent></wps:txbx>` +
  `</wps:wsp></w:drawing></w:r>` +
  `<w:r><w:t> Ordinary text after the shape.</w:t></w:r></w:p>`;

const contentTypes = (hasImage) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  (hasImage ? `<Default Extension="png" ContentType="image/png"/>` : '') +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
  `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
  `</Types>`;

const rootRelationships =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `</Relationships>`;

const styles =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>` +
  `</w:styles>`;

const coreProperties = (title) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
  `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">` +
  `<dc:title>${xml(title)}</dc:title><dc:creator>Synthetic Fixture Generator</dc:creator>` +
  `<dc:subject>Document Optimizer self-validation</dc:subject>` +
  `<dcterms:created>2026-09-17T00:00:00Z</dcterms:created>` +
  `<dcterms:modified>2026-09-17T00:00:00Z</dcterms:modified>` +
  `</cp:coreProperties>`;

const appProperties = (pages, words) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
  `<Application>Document Optimizer Fixture Generator</Application>` +
  `<Pages>${String(pages)}</Pages><Words>${String(words)}</Words></Properties>`;

const documentXml = (body) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<w:body>${body}<w:sectPr/></w:body></w:document>`;

const documentRelationships = (hasImage) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  (hasImage
    ? `<Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/figure.png"/>`
    : '') +
  `</Relationships>`;

const zipBuffer = async (entries) => {
  const archive = new yazl.ZipFile();
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    archive.outputStream.on('data', (chunk) => chunks.push(chunk));
    archive.outputStream.once('error', reject);
    archive.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, data, compress = true] of entries) {
    archive.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), name, {
      mtime: fixedDate,
      mode: 0o100644,
      compress,
    });
  }
  archive.end();
  return await complete;
};

const createDocx = async ({
  title,
  body,
  pages = 1,
  words = 20,
  image = false,
  imageData = png,
  relationships = documentRelationships(image),
  document = documentXml(body),
  extraEntries = [],
}) => {
  const entries = [
    [contentTypesEntry, contentTypes(image)],
    ['_rels/.rels', rootRelationships],
    ['word/document.xml', document],
    ['word/styles.xml', styles],
    ['word/_rels/document.xml.rels', relationships],
    ['docProps/core.xml', coreProperties(title)],
    ['docProps/app.xml', appProperties(pages, words)],
    ...extraEntries,
  ];
  if (image) entries.push(['word/media/figure.png', imageData, false]);
  return await zipBuffer(entries);
};

const contentTypesEntry = '[Content_Types].xml';

const createPdfFixtures = async () => {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Document Optimizer PDF Fixture');
  pdf.setAuthor('Synthetic Fixture Generator');
  pdf.setSubject('Page provenance and outline extraction');
  pdf.setCreator('Document Optimizer Fixture Generator');
  pdf.setProducer('pdf-lib');
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const first = pdf.addPage([612, 792]);
  first.drawText('Document Optimizer PDF Fixture', {
    x: 50,
    y: 740,
    size: 22,
    font: bold,
    color: rgb(0, 0, 0),
  });
  first.drawText('Executive Summary', { x: 50, y: 700, size: 16, font: bold });
  first.drawText('The release evidence preserves page-level provenance for agents.', {
    x: 50,
    y: 675,
    size: 11,
    font: regular,
  });
  first.drawText('Agents can retrieve a compact section instead of the complete source.', {
    x: 50,
    y: 655,
    size: 11,
    font: regular,
  });
  const second = pdf.addPage([612, 792]);
  second.drawText('Deployment Evidence', { x: 50, y: 740, size: 16, font: bold });
  second.drawText('The process listens on port 8080 and readiness uses TCP port 8080.', {
    x: 50,
    y: 715,
    size: 11,
    font: regular,
  });
  const image = await pdf.embedPng(png);
  second.drawImage(image, { x: 50, y: 620, width: 100, height: 50 });
  await writeFile(join(outputDirectory, 'text.pdf'), await pdf.save({ useObjectStreams: false }));

  const recoverable = await PDFDocument.create();
  recoverable.setTitle('Recoverable PDF Resource Fixture');
  recoverable.setCreationDate(fixedDate);
  recoverable.setModificationDate(fixedDate);
  const recoverableFont = await recoverable.embedFont(StandardFonts.Helvetica);
  const recoverablePage = recoverable.addPage([400, 300]);
  recoverablePage.drawText('Real text survives a broken optional image resource.', {
    x: 30,
    y: 240,
    size: 12,
    font: recoverableFont,
  });
  const brokenStream = recoverable.context.flateStream('q /MissingImage Do Q');
  recoverablePage.node.addContentStream(recoverable.context.register(brokenStream));
  await writeFile(
    join(outputDirectory, 'recoverable-resource-error.pdf'),
    await recoverable.save({ useObjectStreams: false }),
  );

  const scanned = await PDFDocument.create();
  scanned.setTitle('Synthetic image-only PDF');
  scanned.setCreationDate(fixedDate);
  scanned.setModificationDate(fixedDate);
  const scannedPage = scanned.addPage([300, 300]);
  const scannedImage = await scanned.embedPng(png);
  scannedPage.drawImage(scannedImage, { x: 20, y: 20, width: 260, height: 260 });
  await writeFile(
    join(outputDirectory, 'image-only.pdf'),
    await scanned.save({ useObjectStreams: false }),
  );

  const taggedContent = [
    '/H1 <</MCID 4>> BDC BT /F1 18 Tf 50 740 Td (Tagged Table Fixture) Tj ET EMC',
    '/TH <</MCID 0>> BDC BT /F1 12 Tf 50 700 Td (Setting) Tj ET EMC',
    '/TH <</MCID 1>> BDC BT /F1 12 Tf 250 700 Td (Value) Tj ET EMC',
    '/TD <</MCID 2>> BDC BT /F1 12 Tf 50 675 Td (Readiness port) Tj ET EMC',
    '/TD <</MCID 3>> BDC BT /F1 12 Tf 250 675 Td (8080) Tj ET EMC',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo << /Marked true >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /StructParents 0 /Tabs /S >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${String(Buffer.byteLength(taggedContent, 'ascii'))} >>\nstream\n${taggedContent}\nendstream`,
    '<< /Type /StructTreeRoot /K [15 0 R 7 0 R] /ParentTree 14 0 R /ParentTreeNextKey 1 >>',
    '<< /Type /StructElem /S /Table /P 6 0 R /Pg 3 0 R /K [8 0 R 11 0 R] >>',
    '<< /Type /StructElem /S /TR /P 7 0 R /Pg 3 0 R /K [9 0 R 10 0 R] >>',
    '<< /Type /StructElem /S /TH /P 8 0 R /Pg 3 0 R /K 0 >>',
    '<< /Type /StructElem /S /TH /P 8 0 R /Pg 3 0 R /K 1 >>',
    '<< /Type /StructElem /S /TR /P 7 0 R /Pg 3 0 R /K [12 0 R 13 0 R] >>',
    '<< /Type /StructElem /S /TD /P 11 0 R /Pg 3 0 R /K 2 >>',
    '<< /Type /StructElem /S /TD /P 11 0 R /Pg 3 0 R /K 3 >>',
    '<< /Nums [0 [9 0 R 10 0 R 12 0 R 13 0 R 15 0 R]] >>',
    '<< /Type /StructElem /S /H1 /P 6 0 R /Pg 3 0 R /K 4 >>',
    '<< /Title (Tagged Table Fixture) /Author (Synthetic Fixture Generator) >>',
  ];
  let taggedPdf = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(taggedPdf, 'binary'));
    taggedPdf += `${String(index + 1)} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(taggedPdf, 'binary');
  taggedPdf += `xref\n0 ${String(objects.length + 1)}\n`;
  taggedPdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    taggedPdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  taggedPdf +=
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Info 16 0 R >>\n` +
    `startxref\n${String(xrefOffset)}\n%%EOF\n`;
  await writeFile(join(outputDirectory, 'tagged-table.pdf'), Buffer.from(taggedPdf, 'binary'));
  await writeFile(join(outputDirectory, 'malformed.pdf'), '%PDF-1.7\nmalformed\n', 'utf8');
};

const createDocxFixtures = async () => {
  await writeFile(
    join(outputDirectory, 'headings.docx'),
    await createDocx({
      title: 'Structured DOCX Fixture',
      body:
        paragraph('Structured DOCX Fixture', 'Heading1') +
        paragraph('Overview', 'Heading2') +
        paragraph('This paragraph retains heading and archive-entry provenance.') +
        listItem('First bounded list item') +
        listItem('Nested bounded list item', 1) +
        paragraph('Details', 'Heading2') +
        paragraph('A second section proves deterministic section ordering.'),
      words: 31,
    }),
  );

  await writeFile(
    join(outputDirectory, 'empty.docx'),
    await createDocx({
      title: 'Empty DOCX Fixture',
      body: '',
      words: 0,
    }),
  );

  await writeFile(
    join(outputDirectory, 'text-box.docx'),
    await createDocx({
      title: 'Text Box Compatibility Fixture',
      body:
        paragraph('Text Box Compatibility', 'Heading1') +
        textBoxParagraph() +
        paragraph('Following ordinary paragraph remains available.'),
      words: 15,
    }),
  );

  await writeFile(
    join(outputDirectory, 'unicode.docx'),
    await createDocx({
      title: 'Unicode Pagination Fixture',
      body: `<w:p><w:r><w:t>&#x1F600; unicode pagination remains valid.</w:t></w:r></w:p>`,
      words: 5,
    }),
  );

  await writeFile(
    join(outputDirectory, 'table.docx'),
    await createDocx({
      title: 'Structured Table Fixture',
      body:
        paragraph('Release Matrix', 'Heading1') +
        table(
          ['Setting', 'Value'],
          [
            ['Listener environment variable', 'PORT'],
            ['Readiness port', '8080'],
          ],
        ),
      words: 12,
    }),
  );

  await writeFile(
    join(outputDirectory, 'escaped-table.docx'),
    await createDocx({
      title: 'Escaped Table Fixture',
      body:
        paragraph('Escaped Table', 'Heading1') +
        table(['Value'], [['|'.repeat(400)], ['|'.repeat(400)]]),
      words: 2,
    }),
  );

  await writeFile(
    join(outputDirectory, 'figure.docx'),
    await createDocx({
      title: 'Embedded Figure Fixture',
      body:
        paragraph('Architecture Figure', 'Heading1') +
        figureParagraph('rIdImage1', 'Synthetic architecture marker for later Vision handoff'),
      words: 9,
      image: true,
    }),
  );

  await writeFile(
    join(outputDirectory, 'alternate-figure.docx'),
    await createDocx({
      title: 'Alternate Figure Fixture',
      body:
        paragraph('Alternate Figure', 'Heading1') +
        alternateFigureParagraph('rIdImage1', 'One logical image'),
      words: 4,
      image: true,
    }),
  );

  await writeFile(
    join(outputDirectory, 'long-section.docx'),
    await createDocx({
      title: 'Long Section Fixture',
      body:
        paragraph('Long Section', 'Heading1') +
        paragraph(
          Array.from(
            { length: 240 },
            (_, index) => `bounded progressive sentence ${String(index + 1)}`,
          ).join('. '),
        ),
      words: 960,
    }),
  );

  await writeFile(
    join(outputDirectory, 'macro-content.docx'),
    await createDocx({
      title: 'Ignored Macro Fixture',
      body:
        paragraph('Macro Safety', 'Heading1') +
        paragraph('Ordinary document text remains available.'),
      extraEntries: [['word/vbaProject.bin', Buffer.from('synthetic macro bytes')]],
    }),
  );

  await writeFile(
    join(outputDirectory, 'external-figure.docx'),
    await createDocx({
      title: 'External Figure Fixture',
      body:
        paragraph('External Figure', 'Heading1') +
        figureParagraph('rIdImage1', 'External image must not be fetched'),
      relationships:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ` +
        `Target="https://example.invalid/image.png" TargetMode="External"/>` +
        `</Relationships>`,
    }),
  );

  await writeFile(
    join(outputDirectory, 'large-figure.docx'),
    await createDocx({
      title: 'Large Figure Fixture',
      body:
        paragraph('Large Figure', 'Heading1') +
        figureParagraph('rIdImage1', 'Image exceeds configured extraction limit'),
      image: true,
      imageData: Buffer.concat([png, Buffer.alloc(2_048, 0x41)]),
    }),
  );

  await writeFile(
    join(outputDirectory, 'nested-archives.docx'),
    await createDocx({
      title: 'Nested Archive Fixture',
      body: paragraph('Nested Archives', 'Heading1'),
      extraEntries: Array.from({ length: 17 }, (_, index) => [
        `word/embeddings/nested-${String(index + 1)}.zip`,
        Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      ]),
    }),
  );

  await writeFile(
    join(outputDirectory, 'compression-bomb.docx'),
    await createDocx({
      title: 'Compression Ratio Fixture',
      body: paragraph('A'.repeat(1_100_000)),
      words: 1,
    }),
  );

  await writeFile(
    join(outputDirectory, 'xml-entity.docx'),
    await createDocx({
      title: 'XML Entity Fixture',
      body: '',
      document:
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<!DOCTYPE w:document [<!ENTITY unsafe "expanded">]>` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:body>${paragraph('&unsafe;')}</w:body></w:document>`,
    }),
  );

  const benchmarkBody =
    paragraph('Checkout API 2.4.0 release evidence', 'Heading1') +
    paragraph('Release identity', 'Heading2') +
    table(
      ['Field', 'Value'],
      [
        ['Service', 'checkout-api'],
        ['Version', '2.4.0'],
        ['Pull request', '1842'],
        ['Candidate image', 'checkout-api:pr-1842'],
      ],
    ) +
    paragraph('Change summary', 'Heading2') +
    paragraph(
      'The application pull request changed src/config.ts, src/server.ts, and test/server.test.ts. The deployment template was not changed in pull request 1842.',
    ) +
    paragraph('Build evidence', 'Heading2') +
    table(
      ['Check', 'Result', 'Notes'],
      [
        ['Application build', 'Passed', 'Exit code 0'],
        ['Container build', 'Passed', 'Reproducible digest recorded'],
        ['Container push', 'Passed', 'Registry acknowledged digest'],
        ['Source-map upload', 'Warning', 'Optional continue-on-error step returned 403'],
      ],
    ) +
    paragraph('Runtime contract RFC-27', 'Heading2') +
    paragraph(
      'Services that adopt RFC-27 consume PORT and do not consume the legacy APP_PORT name.',
    ) +
    table(
      ['Setting', 'Contract'],
      [
        ['Listener environment variable', 'PORT'],
        ['Local default', '3000'],
        ['Deployed value', '8080'],
        ['Bind address', '0.0.0.0'],
        ['Standard health route', '/healthz'],
      ],
    ) +
    paragraph('Deployment policy', 'Heading2') +
    table(
      ['Policy', 'Candidate value', 'Result'],
      [
        ['Ingress target', '8080', 'Passed'],
        ['Readiness transport', 'TCP', 'Passed'],
        ['Readiness port', '8080', 'Passed'],
      ],
    ) +
    paragraph('Rollout timeline', 'Heading2') +
    table(
      ['Time (UTC)', 'Event'],
      [
        ['18:02:03', 'Revision resource was created'],
        ['18:02:06', 'Application emitted startup event'],
        ['18:02:09', 'First readiness failure'],
        ['18:02:20', 'Pipeline marked readiness failed'],
      ],
    ) +
    paragraph('Evidence retention', 'Heading2') +
    paragraph(
      'No live provider or secret material is required for this synthetic release evidence.',
    );
  await writeFile(
    join(outputDirectory, 'benchmark-release-evidence.docx'),
    await createDocx({
      title: 'Checkout API 2.4.0 release evidence',
      body: benchmarkBody,
      pages: 4,
      words: 190,
    }),
  );

  await writeFile(
    join(outputDirectory, 'malformed.docx'),
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('malformed')]),
  );
  const unsafe = await zipBuffer([['xx/evil.txt', 'unsafe']]);
  const unsafeName = Buffer.from('xx/evil.txt', 'ascii');
  const traversalName = Buffer.from('../evil.txt', 'ascii');
  let offset = unsafe.indexOf(unsafeName);
  while (offset >= 0) {
    traversalName.copy(unsafe, offset);
    offset = unsafe.indexOf(unsafeName, offset + traversalName.length);
  }
  await writeFile(join(outputDirectory, 'unsafe-entry.docx'), unsafe);
};

await mkdir(outputDirectory, { recursive: true });
await createPdfFixtures();
await createDocxFixtures();
