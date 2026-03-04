import { config } from 'config'
import { EmailLog } from 'db/models'

export interface SendEmailOptions {
  to: string
  subject: string
  html: string
  creatorId?: string
  orgId?: string
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  const apiKey = config.email.sendgridApiKey
  if (!apiKey) {
    console.warn('SENDGRID_API_KEY not configured — skipping email send')
    return
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: opts.to }] }],
      from: { email: config.email.fromEmail },
      subject: opts.subject,
      content: [{ type: 'text/html', value: opts.html }],
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    console.warn(`SendGrid error ${response.status}: ${body}`)
    return
  }

  await EmailLog.create({
    creatorId: opts.creatorId || undefined,
    orgId: opts.orgId || undefined,
    from: config.email.fromEmail,
    to: opts.to,
    subject: opts.subject,
    body: opts.html,
  })
}
