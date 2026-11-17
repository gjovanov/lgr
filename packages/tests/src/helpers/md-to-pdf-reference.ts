import type { MarkdownToPdfOptions } from 'reporting/pdf/base.pdf'

/**
 * The page md-to-pdf handed Chrome (its `as_html`): the reference of the PDF parity test
 * (`unit/pdf-renderer.test.ts`), and the only use left of the previous renderer. It printed pages
 * unlocked (see `lockPage` in `reporting/pdf/base.pdf.ts`), so the `PDF_RENDERER=md-to-pdf` switch
 * that brought it back is gone.
 *
 * FR-32.9 (#797): it lives here, and md-to-pdf is a dependency of the tests package only. Until then
 * both were in `reporting`, a package the server ships. Test fixtures only: never hand this
 * anything a person typed.
 */
export async function mdToPdfPageDom(content: string, options?: MarkdownToPdfOptions): Promise<string> {
  const { mdToPdf } = await import('md-to-pdf')
  const result = await mdToPdf({ content }, {
    ...(options?.css ? { css: options.css } : {}),
    as_html: true,
    launch_options: { args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] },
  } as any)
  return String(result?.content ?? '')
}
