export interface Column<Row> {
  key: string
  label: string
  align?: 'start' | 'end'
  render: (row: Row) => React.ReactNode
}

// The one table shape every view uses. It is markup over design-system tokens, not a component
// library: the registry's Table copy-in (see the README's design-system note) replaces it once
// the CF Access service tokens exist on the machine that builds.
export function StatTable<Row>({ caption, columns, rows, rowKey, empty }: {
  caption: string
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string
  empty: string
}) {
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">{empty}</p>
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={`px-4 py-2 font-medium ${column.align === 'end' ? 'text-right' : 'text-left'}`}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-border border-t">
              {columns.map((column) => (
                <td key={column.key} className={`px-4 py-2 ${column.align === 'end' ? 'text-right tabular-nums' : 'text-left'}`}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export const money = (value: number | null): string => value === null ? 'Unavailable' : `$${value.toFixed(2)}`
export const quantity = (value: number | null): string => value === null ? 'Unavailable' : String(value)
export const hours = (value: number | null): string => value === null ? 'Unavailable' : `${value.toFixed(1)}h`
export const seconds = (value: number | null): string => value === null ? 'Unavailable' : `${value.toFixed(1)}s`
export const ratio = (value: number | null): string => value === null ? 'Unavailable' : value.toFixed(2)
