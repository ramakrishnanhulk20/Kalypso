/** A translator a pure function can take: the shape of next-intl's t, without its key typing. */
export type PlainT = (key: string, values?: Record<string, string | number | Date>) => string;
