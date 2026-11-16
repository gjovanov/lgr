// The assets this package imports (FR-32.1). Bun gives a `with { type: 'text' }` import its text
// and a `with { type: 'file' }` import its path, both strings; TypeScript knows neither form until
// it is told. Types only: nothing here runs.
declare module '*.css' {
  const text: string
  export default text
}

declare module '*.png' {
  const path: string
  export default path
}
