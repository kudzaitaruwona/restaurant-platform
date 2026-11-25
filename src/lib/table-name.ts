/**
 * A table as guests, the kitchen and the floor read it (#99): a label that is only
 * a number ("7", "12b") would read as a count beside quantities and seats, so it
 * says "Table 7". Any other label ("Table 7", "T3", "Patio") is already a name.
 */
export const tableName = (label: string) => (/^\d+[a-z]?$/i.test(label) ? `Table ${label}` : label);
