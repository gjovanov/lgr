export async function markdownToPdf(content: string): Promise<Buffer | undefined> {
  const { mdToPdf } = await import('md-to-pdf')
  const result = await mdToPdf({ content }, {
    pdf_options: {
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    },
    // Required when the process runs as root inside the container image.
    // Puppeteer's Chromium refuses to launch without a sandbox unless opted out.
    launch_options: {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  })
  return result?.content
}

export function buildHeader(title: string, orgName: string, period?: string): string {
  let md = `# ${title}\n\n`
  md += `**Organization:** ${orgName}\n\n`
  if (period) md += `**Period:** ${period}\n\n`
  md += `**Generated:** ${new Date().toLocaleDateString()}\n\n---\n\n`
  return md
}
