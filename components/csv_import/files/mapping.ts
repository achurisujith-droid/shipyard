/**
 * Matching their column names to yours.
 *
 * Nobody's spreadsheet uses your field names. It says "E-mail Address", or
 * "Client Name", or "Tel". Making the founder rename their columns before
 * uploading is the point at which most imports get abandoned, so the guessing
 * happens here and the person only corrects what it got wrong.
 *
 * The guess is always shown and always editable. An import that silently maps
 * "Name" to the wrong field produces a database full of plausible nonsense,
 * which is much worse than one that fails.
 */

export interface FieldSpec {
  /** Your field name. */
  key: string;
  /** What the person reads. */
  label: string;
  required?: boolean;
  /** Other things people call this column. */
  aliases?: string[];
  kind?: 'text' | 'email' | 'number' | 'date' | 'boolean';
}

/** Reduce a header to something comparable: "E-mail Address" → "emailaddress". */
export function normalise(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ColumnMapping {
  /** Index in the uploaded file, or null when nothing matched. */
  columnIndex: number | null;
  field: FieldSpec;
  /** How the match was made, so the screen can say "we guessed this". */
  how: 'exact' | 'alias' | 'contains' | 'unmatched';
}

/**
 * Guess the mapping.
 *
 * Exact first, then declared aliases, then containment — in that order, so a
 * column literally called `email` always wins over one called
 * `email_verified_at` that merely contains it.
 */
export function guessMapping(headers: readonly string[], fields: readonly FieldSpec[]): ColumnMapping[] {
  const normalised = headers.map(normalise);
  const taken = new Set<number>();

  const claim = (index: number): boolean => {
    if (index < 0 || taken.has(index)) return false;
    taken.add(index);
    return true;
  };

  const mappings: ColumnMapping[] = fields.map((field) => ({ columnIndex: null, field, how: 'unmatched' }));

  for (const [pass, matcher] of (
    [
      ['exact', (header: string, field: FieldSpec) => header === normalise(field.key) || header === normalise(field.label)],
      ['alias', (header: string, field: FieldSpec) => (field.aliases ?? []).some((alias) => normalise(alias) === header)],
      [
        'contains',
        (header: string, field: FieldSpec) => {
          const key = normalise(field.key);
          return key.length >= 4 && (header.includes(key) || key.includes(header));
        },
      ],
    ] as const
  )) {
    for (const [fieldIndex, field] of fields.entries()) {
      const mapping = mappings[fieldIndex];
      if (!mapping || mapping.columnIndex !== null) continue;
      const found = normalised.findIndex((header, index) => !taken.has(index) && matcher(header, field));
      if (found !== -1 && claim(found)) {
        mapping.columnIndex = found;
        mapping.how = pass;
      }
    }
  }

  return mappings;
}

/** Required fields nobody's spreadsheet supplied. */
export function missingRequired(mappings: readonly ColumnMapping[]): FieldSpec[] {
  return mappings.filter((mapping) => mapping.field.required && mapping.columnIndex === null).map((mapping) => mapping.field);
}

/** Columns in their file that nothing is reading. Worth showing, never fatal. */
export function unusedColumns(headers: readonly string[], mappings: readonly ColumnMapping[]): string[] {
  const used = new Set(mappings.map((mapping) => mapping.columnIndex).filter((index): index is number => index !== null));
  return headers.filter((_, index) => !used.has(index));
}
