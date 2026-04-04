/**
 * Generic CSV export utility for admin data tables.
 * Takes rows (array of objects) and column definitions,
 * generates a CSV file and triggers download.
 */

type ColumnDef = {
  key: string;
  label: string;
  /** Optional formatter — called with the raw value */
  format?: (value: unknown) => string;
};

function escapeCSV(value: unknown): string {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportToCsv(
  rows: Record<string, unknown>[],
  columns: ColumnDef[],
  filename: string,
) {
  if (rows.length === 0) return;

  const header = columns.map((c) => escapeCSV(c.label)).join(',');
  const body = rows.map((row) =>
    columns
      .map((col) => {
        const raw = row[col.key];
        const formatted = col.format ? col.format(raw) : raw;
        return escapeCSV(formatted);
      })
      .join(','),
  );

  const csv = [header, ...body].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }); // BOM for Excel
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
