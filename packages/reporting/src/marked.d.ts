// `marked` 4.3.0 ships no types (#797). What `pdf/base.pdf.ts#pageHtml` calls of it, and nothing more:
// its synchronous `parse` with the two options md-to-pdf passed. Types only: nothing here runs.
declare module 'marked' {
  export const marked: {
    parse(
      src: string,
      options?: { highlight?: (code: string, languageName: string) => string; langPrefix?: string },
    ): string
  }
}
