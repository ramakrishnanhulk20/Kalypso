import { CSV_DEFAULT_MAX_BYTES, CSV_DEFAULT_MAX_ROWS, CSV_NAME_MAX_CHARACTERS, parsePayrollCsv } from "@kalypso/core";
import type { CsvError, CsvErrorCode, CsvRow } from "@kalypso/core";
import type { CsvProblem } from "./errors";

// What is wrong, as the rest of a sentence that starts with the line. None of them repeats a cell,
// because a cell can be a salary or a pasted secret key.
const REASONS: Record<Exclude<CsvErrorCode, "DUPLICATE">, string> = {
  FILE_TOO_LARGE: `is larger than ${Math.floor(CSV_DEFAULT_MAX_BYTES / 1024)} KB. Split it into smaller files.`,
  TOO_MANY_ROWS: `has more than ${CSV_DEFAULT_MAX_ROWS} payroll rows. Split it into smaller files.`,
  NO_ROWS: "has no payroll rows. Each row needs a worker's address and an amount.",
  UNCLOSED_QUOTE: "opens a quote mark that is never closed, so the rest of the file cannot be read safely.",
  LINE_ENDINGS: 'uses a line break the importer does not accept. Save the file again as "CSV UTF-8".',
  QUOTE: 'has a quote mark in the wrong place. A quoted cell must start and end with a quote, with "" for a quote inside it.',
  EXTRA_COLUMN: "has more than 3 cells. Use address, amount and an optional name, with any comma inside a name in quotes.",
  MISSING_COLUMN: "needs an address and an amount, separated by a comma (not a semicolon).",
  AMOUNT_SPLIT: "has a name that is only a number, which usually means a comma split the amount. Write the amount without commas.",
  NAME_TOO_LONG: `has a name longer than ${CSV_NAME_MAX_CHARACTERS} characters.`,
  NAME_INVALID: "has a name with a control character, such as a tab or a line break.",
  ADDRESS_EMPTY: "has no worker address.",
  ADDRESS_MUXED_NOT_ALLOWED: "has a muxed address (starting with M). Use the worker's plain G address.",
  ADDRESS_LOOKS_LIKE_SECRET: "has what looks like a secret key (starting with S) instead of an address. Delete it from the file and never share it.",
  ADDRESS_INVALID: "has an address that is not a valid Stellar address. Check it for typos.",
  AMOUNT_EMPTY: "has no amount.",
  AMOUNT_NOT_A_NUMBER: "has an amount that is not a plain number. Use digits with an optional dot, like 1250.50.",
  AMOUNT_NEGATIVE: "has a negative amount. Pay amounts must be above zero.",
  AMOUNT_ZERO: "has an amount of zero. Pay amounts must be above zero.",
  AMOUNT_TOO_MANY_DECIMALS: "has an amount with more than 7 decimal places. USDC stops at 0.0000001.",
  AMOUNT_EXPONENT: "has an amount in scientific notation, like 1e3. Write the full number.",
  AMOUNT_SEPARATOR: "has an amount with a thousands separator or a comma. Write 1000.50, not 1,000.50.",
  AMOUNT_TOO_LARGE: "has an amount larger than the token can hold.",
};

// core's DUPLICATE message is its own fixed text with the earlier line's number in it, never a cell.
const EARLIER_LINE = /on line (\d+)\./;

/**
 * One CSV error from core's parser as a plain sentence that names the line ("Line 4 has no
 * amount."), or the file when the error is about the whole file. An error code this table does not
 * know keeps core's own message, which also never repeats a cell.
 */
export function csvSentence(error: CsvError): string {
  const where = error.line === 0 ? "The file" : `Line ${error.line}`;
  if (error.code === "DUPLICATE") {
    const first = EARLIER_LINE.exec(error.message)?.[1];
    return `${where} repeats the address on line ${first ?? "an earlier line"}. List each worker once, with their total for the run.`;
  }
  const reason = Object.hasOwn(REASONS, error.code) ? REASONS[error.code as keyof typeof REASONS] : undefined;
  return reason === undefined ? `${where}: ${error.message}` : `${where} ${reason}`;
}

/**
 * Reads a payroll spreadsheet saved as CSV through core's one parser, as is (threat model C26):
 * the rows are exactly what core's parser returned, and every refusal becomes a sentence naming
 * its line. A run must not start while problems is non-empty.
 */
export function readPayrollCsv(text: string): { rows: CsvRow[]; problems: CsvProblem[] } {
  const { rows, errors } = parsePayrollCsv(text);
  return { rows, problems: errors.map((error) => ({ line: error.line, code: error.code, sentence: csvSentence(error) })) };
}
