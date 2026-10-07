// Does NOT cover: the roster and registration checks (they need the chain), reading the file
// from disk or a browser File, or how the UI shows errors. The secret seed in payroll-bad.csv
// is a placeholder filled in here, so no secret-shaped string is ever committed.
import { readFileSync } from 'node:fs';
import { StrKey } from '@stellar/stellar-sdk/base';
import { describe, expect, it, vi } from 'vitest';
import { parseAccount } from '../src/addresses.js';
import { MAX_STROOPS } from '../src/amounts.js';
import { CSV_DEFAULT_MAX_BYTES, CSV_DEFAULT_MAX_ROWS, parsePayrollCsv, toSafeCsvCell, type CsvError } from '../src/csv.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const gAddress = (n: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));
const indexedAddress = (i: number) => {
  const bytes = Buffer.alloc(32, 0x5a);
  bytes.writeUInt32BE(i, 0);
  return StrKey.encodeEd25519PublicKey(bytes);
};
const SECRET = StrKey.encodeEd25519SecretSeed(Buffer.alloc(32, 0x99));
const A = gAddress(0x61);
const B = gAddress(0x62);
const C = StrKey.encodeContract(Buffer.alloc(32, 0x63));

const codes = (errors: CsvError[]) => errors.map(({ line, code }) => ({ line, code }));

describe('payroll-good.csv', () => {
  it('returns every row with exactly the values the address and amount parsers give', () => {
    const { rows, errors } = parsePayrollCsv(fixture('payroll-good.csv'));
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { line: 2, kind: 'G', address: 'GAOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBZLGR', amount: 25_000_000_000n, name: 'Ana Lima', nameLooksLikeFormula: false },
      { line: 3, kind: 'G', address: 'GANRWGY3DMNRWGY3DMNRWGY3DMNRWGY3DMNRWGY3DMNRWGY3DMNRXEO4', amount: 31_005_000_000n, name: 'Okafor, Chidi', nameLooksLikeFormula: false },
      { line: 4, kind: 'C', address: 'CARCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEVQO', amount: 18_751_234_567n, name: 'Passkey worker', nameLooksLikeFormula: false },
      { line: 5, kind: 'G', address: 'GANBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBULW6', amount: 1n, nameLooksLikeFormula: false },
      { line: 7, kind: 'G', address: 'GAMRSGIZDEMRSGIZDEMRSGIZDEMRSGIZDEMRSGIZDEMRSGIZDEMRT36Z', amount: 120_000_000_000n, name: 'Renee "Rae" Park', nameLooksLikeFormula: false },
    ]);
    for (const row of rows) {
      expect(parseAccount(row.address)).toEqual({ kind: row.kind, address: row.address });
    }
  });
});

describe('payroll-bad.csv', () => {
  const text = fixture('payroll-bad.csv');

  it('holds the secret seed placeholder exactly once', () => {
    expect(text.split('{{SECRET_SEED}}').length).toBe(2);
  });

  it('rejects every bad line with its own code and keeps only the good lines', () => {
    const { rows, errors } = parsePayrollCsv(text.replace('{{SECRET_SEED}}', SECRET));
    expect(codes(errors)).toEqual([
      { line: 2, code: 'AMOUNT_TOO_MANY_DECIMALS' },
      { line: 3, code: 'AMOUNT_EXPONENT' },
      { line: 4, code: 'AMOUNT_SEPARATOR' },
      { line: 5, code: 'AMOUNT_NEGATIVE' },
      { line: 6, code: 'AMOUNT_ZERO' },
      { line: 8, code: 'DUPLICATE' },
      { line: 9, code: 'ADDRESS_MUXED_NOT_ALLOWED' },
      { line: 10, code: 'ADDRESS_LOOKS_LIKE_SECRET' },
      { line: 11, code: 'ADDRESS_INVALID' },
      { line: 12, code: 'EXTRA_COLUMN' },
      { line: 13, code: 'AMOUNT_SPLIT' },
    ]);
    expect(rows.map((row) => [row.line, row.amount])).toEqual([
      [7, 15_000_000_000n],
      [14, 2_505_000_000n],
    ]);
    for (const error of errors) expect(error.message.length).toBeGreaterThan(10);
  });

  it('never echoes the secret seed, or any piece of it, in the errors', () => {
    const { errors } = parsePayrollCsv(text.replace('{{SECRET_SEED}}', SECRET));
    const everything = JSON.stringify(errors);
    expect(everything).not.toContain(SECRET);
    for (let start = 0; start + 12 <= SECRET.length; start += 4) {
      expect(everything).not.toContain(SECRET.slice(start, start + 12));
    }
  });

  it('points the duplicate at the first line that used the address', () => {
    const { errors } = parsePayrollCsv(text.replace('{{SECRET_SEED}}', SECRET));
    expect(errors.find((e) => e.code === 'DUPLICATE')?.message).toContain('line 7');
  });
});

describe('file limits', () => {
  it('refuses an over-size file with one error and no rows', () => {
    const row = `${A},100,Ana\n`;
    const big = row.repeat(Math.ceil((CSV_DEFAULT_MAX_BYTES + 1) / row.length));
    expect(parsePayrollCsv(big)).toEqual({ rows: [], errors: [expect.objectContaining({ line: 0, code: 'FILE_TOO_LARGE' })] });
  });

  it('counts UTF-8 bytes, not characters', () => {
    const text = `${A},100,${'\u00e9'.repeat(40)}`;
    expect(text.length).toBeLessThan(120);
    expect(codes(parsePayrollCsv(text, { maxBytes: 120 }).errors)).toEqual([{ line: 0, code: 'FILE_TOO_LARGE' }]);
    expect(parsePayrollCsv(text, { maxBytes: 160 }).rows).toHaveLength(1);
  });

  it('refuses an over-row file with one error and no rows, and accepts exactly the cap', () => {
    const lines = (count: number) =>
      ['address,amount', ...Array.from({ length: count }, (_, i) => `${indexedAddress(i)},1`)].join('\n');
    const atCap = parsePayrollCsv(lines(CSV_DEFAULT_MAX_ROWS));
    expect(atCap.errors).toEqual([]);
    expect(atCap.rows).toHaveLength(CSV_DEFAULT_MAX_ROWS);

    const over = parsePayrollCsv(lines(CSV_DEFAULT_MAX_ROWS + 1));
    expect(over.rows).toEqual([]);
    expect(codes(over.errors)).toEqual([{ line: 0, code: 'TOO_MANY_ROWS' }]);
  });

  it('honours smaller caps and refuses caps that are not positive whole numbers', () => {
    expect(codes(parsePayrollCsv(`${A},1\n${B},2`, { maxRows: 1 }).errors)).toEqual([{ line: 0, code: 'TOO_MANY_ROWS' }]);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parsePayrollCsv('', { maxBytes: bad })).toThrow(RangeError);
      expect(() => parsePayrollCsv('', { maxRows: bad })).toThrow(RangeError);
    }
    expect(() => parsePayrollCsv(42 as unknown as string)).toThrow(TypeError);
  });

  it('reports a file with no payroll rows', () => {
    for (const text of ['', '\n\n', 'address,amount,name\n', '\ufeff', ' , , \n,,']) {
      expect(parsePayrollCsv(text)).toEqual({ rows: [], errors: [expect.objectContaining({ line: 0, code: 'NO_ROWS' })] });
    }
  });
});

describe('encoding and line breaks', () => {
  it('strips a UTF-8 byte order mark, so a quoted first cell still reads as quoted', () => {
    const withHeader = parsePayrollCsv(`\ufeffaddress,amount,name\n${A},10,Ana`);
    expect(withHeader.errors).toEqual([]);
    expect(withHeader.rows).toEqual([{ line: 2, kind: 'G', address: A, amount: 100_000_000n, name: 'Ana', nameLooksLikeFormula: false }]);

    const quotedFirst = parsePayrollCsv(`\ufeff"${A}","10"`);
    expect(quotedFirst.errors).toEqual([]);
    expect(quotedFirst.rows[0]?.address).toBe(A);
  });

  it('reads CRLF line endings with the same values and line numbers as LF', () => {
    const lines = ['address,amount,name', `${A},10.5,Ana`, '', `${B},20,"Okafor, Chidi"`];
    const lf = parsePayrollCsv(lines.join('\n'));
    const crlf = parsePayrollCsv(lines.join('\r\n') + '\r\n');
    expect(crlf).toEqual(lf);
    expect(crlf.rows.map((row) => [row.line, row.name])).toEqual([
      [2, 'Ana'],
      [4, 'Okafor, Chidi'],
    ]);
  });

  it('stops on a lone carriage return instead of merging lines', () => {
    const result = parsePayrollCsv(`${A},10\r${B},20`);
    expect(result.rows).toEqual([]);
    expect(codes(result.errors)).toEqual([{ line: 1, code: 'LINE_ENDINGS' }]);
  });

  it('skips blank lines and rows of empty cells without renumbering', () => {
    const { rows, errors } = parsePayrollCsv(`\n${A},1\n   \n,,\n\t\n${B},2\n\n`);
    expect(errors).toEqual([]);
    expect(rows.map((row) => row.line)).toEqual([2, 6]);
  });
});

describe('quoting', () => {
  it('keeps a quoted name containing a comma, and doubled quotes inside it', () => {
    const { rows, errors } = parsePayrollCsv(`${A},100,"Okafor, Chidi"\n${B},100,  "Say ""hi"", Bob"  `);
    expect(errors).toEqual([]);
    expect(rows.map((row) => row.name)).toEqual(['Okafor, Chidi', 'Say "hi", Bob']);
  });

  it('refuses a quote in the middle of a cell or text after a closing quote', () => {
    const { rows, errors } = parsePayrollCsv(`${A},100,Al"ice\n${B},"100"x,Bob\n${C},5,Cara`);
    expect(codes(errors)).toEqual([
      { line: 1, code: 'QUOTE' },
      { line: 2, code: 'QUOTE' },
    ]);
    expect(rows.map((row) => row.address)).toEqual([C]);
  });

  it('stops on a quote that never closes, naming the line it opened on', () => {
    const result = parsePayrollCsv(`${A},1,Ana\n${B},2,"Bob\n${C},3,Cara\n`);
    expect(result.rows).toEqual([]);
    expect(codes(result.errors)).toEqual([{ line: 2, code: 'UNCLOSED_QUOTE' }]);
  });
});

describe('names', () => {
  it('keeps a formula-like name as plain text and flags it', () => {
    const payload = '=HYPERLINK("https://evil.example","Click")';
    const text = [
      `${A},1,"${payload.replace(/"/g, '""')}"`,
      `${B},1,+cmd`,
      `${C},1,"\t-2+3"`,
      `${gAddress(0x64)},1,@SUM(A1)`,
      `${gAddress(0x65)},1,Ana`,
    ].join('\n');
    const { rows, errors } = parsePayrollCsv(text);
    expect(errors).toEqual([]);
    expect(rows.map((row) => [row.name, row.nameLooksLikeFormula])).toEqual([
      [payload, true],
      ['+cmd', true],
      ['-2+3', true],
      ['@SUM(A1)', true],
      ['Ana', false],
    ]);
    expect(toSafeCsvCell(rows[0]?.name ?? '')).toBe(`"'${payload.replace(/"/g, '""')}"`);
  });

  it('accepts names up to 64 characters, counting characters rather than code units', () => {
    const emoji = '\u{1F469}'.repeat(64);
    const { rows, errors } = parsePayrollCsv(`${A},1,${'x'.repeat(64)}\n${B},1,${emoji}\n${C},1,${'y'.repeat(65)}`);
    expect(rows.map((row) => row.name)).toEqual(['x'.repeat(64), emoji]);
    expect(codes(errors)).toEqual([{ line: 3, code: 'NAME_TOO_LONG' }]);
  });

  it('refuses control characters in a name and keeps later line numbers right', () => {
    const { rows, errors } = parsePayrollCsv(`${A},1,"Ana\nLima"\n${B},2,"B\u0000ob"\n${C},3,Cara`);
    expect(codes(errors)).toEqual([
      { line: 1, code: 'NAME_INVALID' },
      { line: 3, code: 'NAME_INVALID' },
    ]);
    expect(rows.map((row) => row.line)).toEqual([4]);
  });

  it('treats an empty name cell as no name', () => {
    expect(parsePayrollCsv(`${A},1,`).rows[0]).toEqual({ line: 1, kind: 'G', address: A, amount: 10_000_000n, nameLooksLikeFormula: false });
  });
});

describe('row shape and amounts', () => {
  it('refuses an amount a comma split into the name cell', () => {
    const { rows, errors } = parsePayrollCsv(`${A},1,000\n${B},1.000,50\n${C},1,5\n${gAddress(0x66)},12,500.50`);
    expect(rows).toEqual([]);
    expect(errors.map((e) => e.code)).toEqual(['AMOUNT_SPLIT', 'AMOUNT_SPLIT', 'AMOUNT_SPLIT', 'AMOUNT_SPLIT']);
  });

  it('refuses rows with too few or too many cells', () => {
    const { errors } = parsePayrollCsv(`${A}\n${B};100;Bob\n${C},1,Cara,extra`);
    expect(codes(errors)).toEqual([
      { line: 1, code: 'MISSING_COLUMN' },
      { line: 2, code: 'MISSING_COLUMN' },
      { line: 3, code: 'EXTRA_COLUMN' },
    ]);
  });

  it('reports an address problem and an amount problem on the same line', () => {
    const { errors } = parsePayrollCsv(`nonsense,1e3,Ana\n${A},,Bob`);
    expect(codes(errors)).toEqual([
      { line: 1, code: 'ADDRESS_INVALID' },
      { line: 1, code: 'AMOUNT_EXPONENT' },
      { line: 2, code: 'AMOUNT_EMPTY' },
    ]);
  });

  it('finds duplicates after decoding, even when the first copy had a bad amount', () => {
    const { rows, errors } = parsePayrollCsv(`${A},abc\n  ${A}  ,10\n${B},5\n"${B}",6`);
    expect(codes(errors)).toEqual([
      { line: 1, code: 'AMOUNT_NOT_A_NUMBER' },
      { line: 2, code: 'DUPLICATE' },
      { line: 4, code: 'DUPLICATE' },
    ]);
    expect(rows.map((row) => row.line)).toEqual([3]);
  });

  it('never puts cell content in an error message', () => {
    const cells = ['1,234.56', '98765.4321e2', '-4242.42', 'Zelda Quintana'];
    const { errors } = parsePayrollCsv(`${A},"${cells[0]}"\n${B},${cells[1]}\n${C},${cells[2]},${cells[3]}`);
    expect(errors).toHaveLength(3);
    const everything = JSON.stringify(errors);
    for (const cell of [...cells, A, B, C, '4242', '98765']) expect(everything).not.toContain(cell);
  });
});

describe('header row', () => {
  it('is optional', () => {
    expect(parsePayrollCsv(`${A},10`).rows).toHaveLength(1);
  });

  it('is recognised only on the first row, and only when it cannot be a payroll row', () => {
    expect(parsePayrollCsv(`wallet,salary\n${A},10`).errors).toEqual([]);
    expect(codes(parsePayrollCsv(`${A},ten\n${B},10`).errors)).toEqual([{ line: 1, code: 'AMOUNT_NOT_A_NUMBER' }]);
    expect(codes(parsePayrollCsv(`address,1000\n${B},10`).errors)).toEqual([
      { line: 1, code: 'ADDRESS_INVALID' },
    ]);
    expect(codes(parsePayrollCsv(`${A},10\naddress,amount`).errors)).toEqual([
      { line: 2, code: 'ADDRESS_INVALID' },
      { line: 2, code: 'AMOUNT_NOT_A_NUMBER' },
    ]);
    expect(codes(parsePayrollCsv(`address,amount,name,notes\n${A},10`).errors)).toEqual([{ line: 1, code: 'EXTRA_COLUMN' }]);
  });

  it('is never a first row that carries digits, so a broken first row is reported, not skipped', () => {
    expect(codes(parsePayrollCsv(`GBROK3N,ten,Ana\n${B},10`).errors)).toEqual([
      { line: 1, code: 'ADDRESS_INVALID' },
      { line: 1, code: 'AMOUNT_NOT_A_NUMBER' },
    ]);
    expect(codes(parsePayrollCsv(`Address,Amount 2026\n${B},10`).errors)).toEqual([
      { line: 1, code: 'ADDRESS_INVALID' },
      { line: 1, code: 'AMOUNT_NOT_A_NUMBER' },
    ]);
  });
});

describe('toSafeCsvCell', () => {
  it.each([
    ['=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@cmd', "'@cmd"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', `"'\rcmd"`],
    ['=1,2', `"'=1,2"`],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['Ana Lima', 'Ana Lima'],
    ['1234.5', '1234.5'],
    ['', ''],
  ])('writes %j as %j', (input, output) => {
    expect(toSafeCsvCell(input)).toBe(output);
  });

  it('round-trips a name with a comma and quotes through the importer', () => {
    const name = 'Okafor, "Chidi"';
    const { rows } = parsePayrollCsv(`${A},1,${toSafeCsvCell(name)}`);
    expect(rows[0]?.name).toBe(name);
  });

  it('refuses values that are not strings', () => {
    expect(() => toSafeCsvCell(5n as unknown as string)).toThrow(TypeError);
  });
});

describe('no output channels', () => {
  it('parses and exports without logging or calling the network', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );
    parsePayrollCsv(fixture('payroll-good.csv'));
    parsePayrollCsv(fixture('payroll-bad.csv').replace('{{SECRET_SEED}}', SECRET));
    toSafeCsvCell('=cmd');
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('seeded fuzz', () => {
  it('never throws, and every accepted row is exactly what the single parsers accept', () => {
    let seed = 0x5eed;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pieces = [A, B, C, ` ${A}`, `${A.slice(0, 30)}`, SECRET, '10', '0', '1.5', '1e3', '-2', '1,000', '"1,000"', '0.00000001',
      'Ana', '"Ok, Chidi"', '=cmd', '"', '""', ',', ',', ',', '\n', '\n', '\r\n', '\r', ' ', '\t', '\ufeff', '\u00e9'];

    for (let round = 0; round < 3000; round++) {
      let text = '';
      const length = 1 + random(40);
      for (let k = 0; k < length; k++) text += pieces[random(pieces.length)];

      const { rows, errors } = parsePayrollCsv(text);
      // Silence is never an answer: an empty or unreadable file still yields an error.
      expect(rows.length + errors.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const row of rows) {
        expect(parseAccount(row.address)).toEqual({ kind: row.kind, address: row.address });
        expect(row.amount >= 1n && row.amount <= MAX_STROOPS).toBe(true);
        expect(seen.has(row.address)).toBe(false);
        seen.add(row.address);
        expect(row.line).toBeGreaterThan(0);
      }
      expect(JSON.stringify(errors)).not.toContain(SECRET.slice(1, 13));
    }
  });
});
