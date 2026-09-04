import JSZip from 'jszip';
import { letterToColumn, columnLetter } from './resolve-layout';

/**
 * Surgical cell writer for .xlsx files.
 *
 * An .xlsx is a zip of XML parts. Libraries that "save" a workbook — ExcelJS
 * included — parse every part into an object model and re-serialise the lot,
 * which silently loses anything the model does not represent. Round-tripping
 * the real master workbook through ExcelJS's writer rewrites the theme font
 * from `Aptos Narrow` to `Calibri`, drops `xl/printerSettings1.bin` and its
 * relationship, and strips `bestFit` from all sixteen column widths.
 *
 * This writer instead edits the sheet XML as text and copies every other zip
 * entry through untouched, so the guarantee is structural rather than a
 * promise: a part that is not the target worksheet cannot change, because
 * nothing ever reads or rewrites it.
 *
 * Two further rules protect the owner's work:
 *   - a cell containing a formula is never overwritten, it is reported back
 *   - the `s=` style index of every edited cell is carried across verbatim
 */

export type CellEdit = {
  /** A1-style reference, e.g. "F6". */
  ref: string;
  /** Numbers are written as numbers; strings go through the shared string table. */
  value: number | string;
};

export type PatchResult = {
  buffer: Buffer;
  applied: number;
  /** Cells left alone because they hold a formula. */
  skippedFormula: string[];
  /** Cells created because the sheet had no element for them. */
  createdCells: string[];
};

const ROW_RE = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : null;
}

/** Drop an attribute from an attribute string, leaving the rest untouched. */
function dropAttr(attrs: string, name: string): string {
  return attrs.replace(new RegExp(`\\s*\\b${name}="[^"]*"`), '');
}

function parseRef(ref: string): { row: number; col: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!m) throw new Error(`Invalid cell reference: "${ref}"`);
  return { row: Number(m[2]), col: letterToColumn(m[1]) };
}

// --------------------------------------------------------------------------
// Shared strings
// --------------------------------------------------------------------------

/**
 * Index of the workbook's shared string table.
 *
 * Only plain `<si><t>…</t></si>` entries are indexed for reuse. Rich-text
 * entries carry formatting runs that a lookup by plain text would discard, so
 * they are counted but never reused.
 */
class SharedStrings {
  private readonly index = new Map<string, number>();
  private readonly additions: string[] = [];
  private count: number;
  private readonly originalXml: string | null;

  constructor(xml: string | null) {
    this.originalXml = xml;
    this.count = 0;
    if (!xml) return;

    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(xml)) !== null) {
      const inner = m[1] ?? '';
      // A plain entry is a single <t> with no formatting runs around it.
      const plain = /^\s*<t(?:\s[^>]*)?>([\s\S]*?)<\/t>\s*$/.exec(inner);
      if (plain) {
        const text = decodeXml(plain[1]);
        if (!this.index.has(text)) this.index.set(text, this.count);
      }
      this.count++;
    }
  }

  get available(): boolean {
    return this.originalXml !== null;
  }

  /** Index for `text`, appending a new entry when the table lacks it. */
  intern(text: string): number {
    const existing = this.index.get(text);
    if (existing !== undefined) return existing;

    const idx = this.count++;
    this.index.set(text, idx);
    const needsSpace = text !== text.trim();
    this.additions.push(
      `<si><t${needsSpace ? ' xml:space="preserve"' : ''}>${escapeXml(text)}</t></si>`
    );
    return idx;
  }

  /** Serialised table, or null when nothing was added. */
  serialize(): string | null {
    if (!this.originalXml || this.additions.length === 0) return null;

    let xml = this.originalXml.replace(
      /<sst\b([^>]*)>/,
      (_full, attrs: string) => {
        const withCount = attrs.replace(/\bcount="\d+"/, `count="${this.count}"`);
        const withUnique = withCount.replace(/\buniqueCount="\d+"/, `uniqueCount="${this.count}"`);
        return `<sst${withUnique}>`;
      }
    );

    // A previously empty table can be self-closing, in which case there is no
    // </sst> to insert before.
    if (/<\/sst>/.test(xml)) {
      xml = xml.replace('</sst>', `${this.additions.join('')}</sst>`);
    } else {
      xml = xml.replace(/<sst\b([^>]*)\/>/, `<sst$1>${this.additions.join('')}</sst>`);
    }
    return xml;
  }
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// --------------------------------------------------------------------------
// Locating the worksheet part
// --------------------------------------------------------------------------

/**
 * Resolve a sheet name to its part path via workbook.xml and its rels,
 * rather than assuming `xl/worksheets/sheet1.xml` — sheet file names do not
 * have to match sheet order, and a deleted-then-recreated tab often breaks
 * that assumption.
 */
async function resolveSheetPath(zip: JSZip, sheetName?: string): Promise<string> {
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  if (!workbookXml) throw new Error('Not a valid .xlsx: xl/workbook.xml is missing.');

  const sheets = [...workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)].map(m => ({
    name: decodeXml(attr(m[1], 'name') ?? ''),
    rid: attr(m[1], 'r:id') ?? attr(m[1], 'id') ?? '',
  }));
  if (sheets.length === 0) throw new Error('Not a valid .xlsx: workbook declares no sheets.');

  const target = sheetName
    ? sheets.find(s => s.name === sheetName)
    : sheets[0];
  if (!target) {
    throw new Error(
      `Sheet "${sheetName}" not found. Sheets in file: ${sheets.map(s => s.name).join(', ')}`
    );
  }

  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (relsXml && target.rid) {
    const rel = [...relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)]
      .map(m => ({ id: attr(m[1], 'Id'), targetPath: attr(m[1], 'Target') }))
      .find(r => r.id === target.rid);
    if (rel?.targetPath) {
      const path = rel.targetPath.replace(/^\/?xl\//, '').replace(/^\//, '');
      const full = `xl/${path}`;
      if (zip.file(full)) return full;
    }
  }

  const fallback = `xl/worksheets/sheet${sheets.indexOf(target) + 1}.xml`;
  if (!zip.file(fallback)) {
    throw new Error(`Could not locate the XML part for sheet "${target.name}".`);
  }
  return fallback;
}

// --------------------------------------------------------------------------
// Cell rewriting
// --------------------------------------------------------------------------

function renderCell(
  ref: string,
  originalAttrs: string,
  value: number | string,
  sst: SharedStrings,
): string {
  // Every original attribute is preserved except `t`, which describes the
  // value we are replacing. `s` — the style index — rides along untouched,
  // which is what keeps number formats, fonts and fills on edited cells.
  let attrs = dropAttr(originalAttrs, 't');
  if (!/\br="/.test(attrs)) attrs = ` r="${ref}"${attrs}`;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Refusing to write ${value} to ${ref}`);
    return `<c${attrs}><v>${value}</v></c>`;
  }

  if (sst.available) {
    return `<c${attrs} t="s"><v>${sst.intern(value)}</v></c>`;
  }
  // No shared string table in this workbook: an inline string is equally
  // valid and avoids having to create the part and register its content type.
  const needsSpace = value !== value.trim();
  return `<c${attrs} t="inlineStr"><is><t${needsSpace ? ' xml:space="preserve"' : ''}>` +
    `${escapeXml(value)}</t></is></c>`;
}

/** Rewrite one `<row>` body, replacing or inserting the cells it owns. */
function patchRowBody(
  body: string,
  rowNum: number,
  edits: Map<number, number | string>,
  sst: SharedStrings,
  skippedFormula: string[],
  createdCells: string[],
): { body: string; touchedCols: number[] } {
  const pending = new Map(edits);
  const touchedCols: number[] = [];

  const rebuilt = body.replace(CELL_RE, (full, attrs: string, inner: string | undefined) => {
    const ref = attr(attrs, 'r');
    if (!ref) return full;
    const { col } = parseRef(ref);
    if (!pending.has(col)) return full;

    const value = pending.get(col)!;
    pending.delete(col);

    // Never clobber a formula the owner wrote. Excel recalculates it on open,
    // so leaving it alone is also the correct result, not just the safe one.
    if (inner && /<f[\s>]/.test(inner)) {
      skippedFormula.push(ref);
      return full;
    }

    touchedCols.push(col);
    return renderCell(ref, attrs, value, sst);
  });

  if (pending.size === 0) return { body: rebuilt, touchedCols };

  // Anything left has no cell element yet — the workbook simply omits blanks.
  // New cells must be spliced in at their correct column position.
  const existing = [...rebuilt.matchAll(CELL_RE)].map(m => ({
    start: m.index!,
    end: m.index! + m[0].length,
    col: parseRef(attr(m[1], 'r') ?? 'A1').col,
  }));

  const inserts: Array<{ at: number; xml: string; col: number }> = [];
  for (const [col, value] of pending) {
    const ref = `${columnLetter(col)}${rowNum}`;
    const xml = renderCell(ref, ` r="${ref}"`, value, sst);
    const after = existing.find(c => c.col > col);
    inserts.push({ at: after ? after.start : rebuilt.length, xml, col });
    createdCells.push(ref);
    touchedCols.push(col);
  }

  // Apply back-to-front so earlier offsets stay valid.
  inserts.sort((a, b) => b.at - a.at);
  let out = rebuilt;
  for (const ins of inserts) out = out.slice(0, ins.at) + ins.xml + out.slice(ins.at);

  return { body: out, touchedCols };
}

/** Widen a row's `spans` hint so it covers the columns we just added. */
function widenSpans(attrs: string, cols: number[]): string {
  if (cols.length === 0) return attrs;
  const spans = attr(attrs, 'spans');
  if (!spans) return attrs;
  const [from, to] = spans.split(':').map(Number);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return attrs;
  const lo = Math.min(from, ...cols);
  const hi = Math.max(to, ...cols);
  if (lo === from && hi === to) return attrs;
  return attrs.replace(/\bspans="[^"]*"/, `spans="${lo}:${hi}"`);
}

/** Grow `<dimension>` if an edit landed outside the recorded used range. */
function widenDimension(xml: string, maxRow: number, maxCol: number): string {
  return xml.replace(/<dimension\b([^>]*?)\/>/, (full, attrs: string) => {
    const ref = attr(attrs, 'ref');
    if (!ref || !ref.includes(':')) return full;
    const [start, end] = ref.split(':');
    const endRef = /^([A-Za-z]+)(\d+)$/.exec(end);
    if (!endRef) return full;
    const col = Math.max(letterToColumn(endRef[1]), maxCol);
    const row = Math.max(Number(endRef[2]), maxRow);
    return `<dimension ref="${start}:${columnLetter(col)}${row}"/>`;
  });
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

/**
 * Apply cell edits to a workbook, returning new file bytes.
 *
 * Edits addressing rows that do not exist yet are rejected rather than
 * guessed at — every caller in this codebase writes only to rows it has just
 * read back from the same file.
 */
export async function applyCellEdits(
  original: Buffer,
  edits: CellEdit[],
  sheetName?: string,
): Promise<PatchResult> {
  if (edits.length === 0) {
    return { buffer: original, applied: 0, skippedFormula: [], createdCells: [] };
  }

  const zip = await JSZip.loadAsync(original);
  const sheetPath = await resolveSheetPath(zip, sheetName);

  const sheetXml = await zip.file(sheetPath)!.async('string');
  const sstXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? null;
  const sst = new SharedStrings(sstXml);

  // Group edits by row so each row element is rewritten exactly once.
  const byRow = new Map<number, Map<number, number | string>>();
  let maxRow = 0;
  let maxCol = 0;
  for (const edit of edits) {
    const { row, col } = parseRef(edit.ref);
    maxRow = Math.max(maxRow, row);
    maxCol = Math.max(maxCol, col);
    let rowEdits = byRow.get(row);
    if (!rowEdits) byRow.set(row, (rowEdits = new Map()));
    rowEdits.set(col, edit.value);
  }

  const skippedFormula: string[] = [];
  const createdCells: string[] = [];
  const seenRows = new Set<number>();
  let applied = 0;

  let patched = sheetXml.replace(ROW_RE, (full, attrs: string, body: string | undefined) => {
    const rowNum = Number(attr(attrs, 'r'));
    const rowEdits = byRow.get(rowNum);
    if (!rowEdits) return full;

    seenRows.add(rowNum);
    const result = patchRowBody(body ?? '', rowNum, rowEdits, sst, skippedFormula, createdCells);
    applied += result.touchedCols.length;
    return `<row${widenSpans(attrs, result.touchedCols)}>${result.body}</row>`;
  });

  const missingRows = [...byRow.keys()].filter(r => !seenRows.has(r)).sort((a, b) => a - b);
  if (missingRows.length > 0) {
    throw new Error(
      `Refusing to write: rows ${missingRows.join(', ')} do not exist in "${sheetPath}". ` +
      `Edits must target rows read from the same file.`
    );
  }

  patched = widenDimension(patched, maxRow, maxCol);

  zip.file(sheetPath, patched);
  const newSst = sst.serialize();
  if (newSst) zip.file('xl/sharedStrings.xml', newSst);

  // Rebuild the archive from the file entries alone. Generating from the
  // loaded zip directly would also emit directory entries that JSZip
  // synthesises but the original file never had; Excel tolerates them, but
  // the point of this writer is that nothing changes unless it had to.
  const output = new JSZip();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    // `createFolders: false` matters: JSZip otherwise synthesises a directory
    // entry for every path segment, which the original file does not have.
    output.file(name, await entry.async('nodebuffer'), {
      date: entry.date,
      createFolders: false,
    });
  }

  const buffer = await output.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return { buffer, applied, skippedFormula, createdCells };
}
