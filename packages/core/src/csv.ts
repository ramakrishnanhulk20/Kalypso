import { utf8ToBytes } from '@noble/hashes/utils.js';
import { AddressError, parseAccount, type AccountKind } from './addresses.js';
import { AmountError, parseUsdc, type Stroops } from './amounts.js';

export const CSV_DEFAULT_MAX_BYTES = 262_144;
export const CSV_DEFAULT_MAX_ROWS = 500;
export const CSV_NAME_MAX_CHARACTERS = 64;

/** One accepted payroll line. address, kind and amount are exactly what parseAccount and parseUsdc returned. */
export interface CsvRow {
  line: number;
  address: string;
  kind: AccountKind;
  amount: Stroops;
  name?: string;
  nameLooksLikeFormula: boolean;
}

/** One refused line, or the whole file when line is 0. The message never contains cell content. */
export interface CsvError {
  line: number;
  code: string;
  message: string;
}

export type CsvErrorCode =
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'NO_ROWS'
  | 'UNCLOSED_QUOTE'
  | 'LINE_ENDINGS'
  | 'QUOTE'
  | 'EXTRA_COLUMN'
  | 'MISSING_COLUMN'
  | 'DUPLICATE'
  | 'AMOUNT_SPLIT'
  | 'NAME_TOO_LONG'
  | 'NAME_INVALID'
  | `ADDRESS_${AddressError['code']}`
  | `AMOUNT_${AmountError['code']}`;

const CSV_MESSAGES = {
  NO_ROWS: 'The file has no payroll rows. Each row needs an address and an amount.',
  UNCLOSED_QUOTE: 'A quote mark opened on this line is never closed, so the rest of the file cannot be read safely.',
  LINE_ENDINGS: 'This file uses a line break the importer does not accept. Save it again as "CSV UTF-8".',
  QUOTE: 'A quote mark is in the wrong place. A quoted cell must start and end with a quote, with "" for a quote inside it.',
  EXTRA_COLUMN:
    'This row has more than 3 cells. Use address, amount and an optional name. A comma inside a name must be in quotes, and amounts take no commas.',
  MISSING_COLUMN: 'This row needs an address and an amount, separated by a comma (not a semicolon).',
  AMOUNT_SPLIT:
    'The name cell holds only a number, which usually means a comma split the amount into two cells. Write the amount without commas, or give the name a letter.',
  NAME_TOO_LONG: `The name is longer than ${CSV_NAME_MAX_CHARACTERS} characters.`,
  NAME_INVALID: 'The name contains a control character such as a line break or a tab.',
} satisfies Partial<Record<CsvErrorCode, string>>;

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;
const NUMBER_ONLY = /^\d[\d.,]*$/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const LETTER = /\p{L}/u;
const DIGIT = /\d/;

interface RawRecord {
  line: number;
  cells: string[];
  malformed: boolean;
}

function fileError(line: number, code: CsvErrorCode, message: string): { rows: CsvRow[]; errors: CsvError[] } {
  return { rows: [], errors: [{ line, code, message }] };
}

function capFrom(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive whole number`);
  return value;
}

// RFC 4180 with two allowances: LF on its own ends a line, and spaces or tabs may sit
// outside a quoted cell. Line numbers count LF characters, so a name with a line break
// inside quotes still leaves later rows numbered as a text editor shows them.
function splitRecords(text: string): { records: RawRecord[] } | { fatal: CsvError } {
  const records: RawRecord[] = [];
  const end = text.length;
  let i = 0;
  let line = 1;

  while (i < end) {
    const record: RawRecord = { line, cells: [], malformed: false };
    for (;;) {
      let j = i;
      while (text[j] === ' ' || text[j] === '\t') j++;

      let cell: string;
      if (text[j] === '"') {
        const openedOn = line;
        let value = '';
        let closed = false;
        i = j + 1;
        while (i < end) {
          const ch = text[i];
          if (ch === '"') {
            if (text[i + 1] === '"') {
              value += '"';
              i += 2;
              continue;
            }
            i++;
            closed = true;
            break;
          }
          if (ch === '\n') line++;
          value += ch;
          i++;
        }
        if (!closed) return { fatal: { line: openedOn, code: 'UNCLOSED_QUOTE', message: CSV_MESSAGES.UNCLOSED_QUOTE } };
        while (text[i] === ' ' || text[i] === '\t') i++;
        if (i < end && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          record.malformed = true;
          while (i < end && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') i++;
        }
        cell = value;
      } else {
        const start = i;
        while (i < end && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          if (text[i] === '"') record.malformed = true;
          i++;
        }
        cell = text.slice(start, i);
      }
      record.cells.push(cell);

      if (i >= end) break;
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === '\r') {
        // A carriage return on its own (old Mac files) would silently merge lines, so it stops the import.
        if (text[i + 1] !== '\n') return { fatal: { line, code: 'LINE_ENDINGS', message: CSV_MESSAGES.LINE_ENDINGS } };
        i++;
      }
      i++;
      line++;
      break;
    }
    records.push(record);
  }
  return { records };
}

function isBlank(record: RawRecord): boolean {
  return !record.malformed && record.cells.every((cell) => cell.trim() === '');
}

function parses(parse: (value: string) => unknown, value: string): boolean {
  try {
    parse(value);
    return true;
  } catch {
    return false;
  }
}

// A header is recognised only when it cannot be a payroll row: its amount cell is not an
// amount and holds a letter, no cell holds a digit, and its address cell is not an account.
// The last two stop a real first row with mistakes, such as "G...,ten" or "GBROK3N,1e3",
// from being skipped as a header without anyone being told.
function isHeader(record: RawRecord): boolean {
  if (record.malformed || record.cells.length < 2 || record.cells.length > 3) return false;
  const [addressCell = '', amountCell = ''] = record.cells;
  return (
    LETTER.test(amountCell) &&
    !parses(parseUsdc, amountCell) &&
    !record.cells.some((cell) => DIGIT.test(cell)) &&
    !parses(parseAccount, addressCell)
  );
}

/**
 * True when a spreadsheet would treat the value as a formula: it starts with = + - @, a tab
 * or a carriage return. This is the one check behind both the import flag and the export guard.
 */
function startsLikeFormula(value: string): boolean {
  return FORMULA_START.test(value);
}

/**
 * Reads an employer's payroll CSV. Columns are address, amount and an optional name; the file
 * may start with a UTF-8 byte order mark and one header row, and may use LF or CRLF line breaks.
 *
 * Every address goes through parseAccount and every amount through parseUsdc, and the row
 * carries exactly the values those return. The file fails closed: over maxBytes, over maxRows,
 * an unclosed quote or a lone carriage return returns one error and no rows. Otherwise each
 * bad line is listed with its line number and reason, and rows holds only the lines that
 * passed every check. A repeated address is refused on the later line. Callers should not
 * start a payroll run while errors is non-empty.
 *
 * @param opts.maxBytes size cap in UTF-8 bytes, default 262144.
 * @param opts.maxRows cap on data rows, default 500. The header and blank lines do not count.
 * @throws RangeError when a cap is not a positive whole number; TypeError when text is not a string.
 */
export function parsePayrollCsv(
  text: string,
  opts?: { maxBytes?: number; maxRows?: number },
): { rows: CsvRow[]; errors: CsvError[] } {
  if (typeof text !== 'string') throw new TypeError('parsePayrollCsv expects the file as text');
  const maxBytes = capFrom(opts?.maxBytes, CSV_DEFAULT_MAX_BYTES, 'maxBytes');
  const maxRows = capFrom(opts?.maxRows, CSV_DEFAULT_MAX_ROWS, 'maxRows');

  // UTF-8 never takes fewer bytes than UTF-16 code units, so the length check alone rejects
  // a huge file before it is encoded.
  if (text.length > maxBytes || utf8ToBytes(text).length > maxBytes) {
    return fileError(0, 'FILE_TOO_LARGE', `The file is larger than ${Math.floor(maxBytes / 1024)} KB.`);
  }

  const split = splitRecords(text.startsWith('\ufeff') ? text.slice(1) : text);
  if ('fatal' in split) return { rows: [], errors: [split.fatal] };

  const records = split.records.filter((record) => !isBlank(record));
  const first = records[0];
  const dataRecords = first !== undefined && isHeader(first) ? records.slice(1) : records;

  if (dataRecords.length === 0) return fileError(0, 'NO_ROWS', CSV_MESSAGES.NO_ROWS);
  if (dataRecords.length > maxRows) {
    return fileError(0, 'TOO_MANY_ROWS', `The file has more than ${maxRows} payroll rows. Split it into smaller files.`);
  }

  const rows: CsvRow[] = [];
  const errors: CsvError[] = [];
  const firstLineFor = new Map<string, number>();
  const refuse = (line: number, code: CsvErrorCode, message: string) => errors.push({ line, code, message });

  for (const record of dataRecords) {
    const { line, cells } = record;
    if (record.malformed) {
      refuse(line, 'QUOTE', CSV_MESSAGES.QUOTE);
      continue;
    }
    if (cells.length > 3) {
      refuse(line, 'EXTRA_COLUMN', CSV_MESSAGES.EXTRA_COLUMN);
      continue;
    }
    if (cells.length < 2) {
      refuse(line, 'MISSING_COLUMN', CSV_MESSAGES.MISSING_COLUMN);
      continue;
    }

    const [addressCell = '', amountCell = '', nameCell = ''] = cells;
    const errorsBefore = errors.length;

    let account: { kind: AccountKind; address: string } | undefined;
    try {
      account = parseAccount(addressCell);
    } catch (err) {
      if (!(err instanceof AddressError)) throw err;
      refuse(line, `ADDRESS_${err.code}`, err.message);
    }

    let amount: Stroops | undefined;
    const name = nameCell.trim();
    // "G...,1,000" is three valid-looking cells: 1 USDC to someone called "000". Refusing a
    // name that is only a number closes that gap, and the same for "1.000,50" and "1,5".
    if (NUMBER_ONLY.test(name)) {
      refuse(line, 'AMOUNT_SPLIT', CSV_MESSAGES.AMOUNT_SPLIT);
    } else {
      try {
        amount = parseUsdc(amountCell);
      } catch (err) {
        if (!(err instanceof AmountError)) throw err;
        refuse(line, `AMOUNT_${err.code}`, err.message);
      }
      if ([...name].length > CSV_NAME_MAX_CHARACTERS) refuse(line, 'NAME_TOO_LONG', CSV_MESSAGES.NAME_TOO_LONG);
      else if (CONTROL_CHARACTER.test(name)) refuse(line, 'NAME_INVALID', CSV_MESSAGES.NAME_INVALID);
    }

    if (account !== undefined) {
      const firstLine = firstLineFor.get(account.address);
      if (firstLine !== undefined) {
        refuse(
          line,
          'DUPLICATE',
          `This address is already on line ${firstLine}. List each worker once, with their total for the run.`,
        );
      } else {
        firstLineFor.set(account.address, line);
      }
    }

    if (errors.length === errorsBefore && account !== undefined && amount !== undefined) {
      const row: CsvRow = { line, address: account.address, kind: account.kind, amount, nameLooksLikeFormula: false };
      if (name !== '') {
        row.name = name;
        row.nameLooksLikeFormula = startsLikeFormula(name);
      }
      rows.push(row);
    }
  }

  return { rows, errors };
}

/**
 * Makes one value safe to place in an exported CSV cell. A value a spreadsheet would run as a
 * formula (starting with = + - @, a tab or a carriage return) gets a leading apostrophe, so it
 * opens as text. A value containing a comma, a quote, a carriage return or a line feed is then
 * wrapped in quotes with inner quotes doubled.
 *
 * @throws TypeError when value is not a string. Format amounts with formatUsdc first.
 */
export function toSafeCsvCell(value: string): string {
  if (typeof value !== 'string') throw new TypeError('toSafeCsvCell expects a string');
  const neutral = startsLikeFormula(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(neutral) ? `"${neutral.replace(/"/g, '""')}"` : neutral;
}
