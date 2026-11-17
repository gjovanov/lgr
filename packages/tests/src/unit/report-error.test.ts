import { describe, it, expect, beforeEach, spyOn } from 'bun:test'
import { reportError } from 'ui-shared/composables/report-error'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

// FR-32.5 (#797): a catch that reports says what the HTTP client left to it, and nothing twice.

const axiosError = (status?: number, message?: string) =>
  Object.assign(new Error('Request failed'), {
    isAxiosError: true,
    ...(status === undefined ? {} : { response: { status, data: message ? { message } : {} } }),
  })

describe('reportError', () => {
  const { snackbar, hideSnackbar } = useSnackbar()
  beforeEach(() => {
    snackbar.queue.splice(0)
    hideSnackbar()
    snackbar.visible = false
  })

  it('says a refusal (4xx) in the server\'s own sentence', () => {
    expect(reportError(axiosError(403, 'Not allowed to read contacts'))).toBe(true)
    expect(snackbar.visible && snackbar.message).toBe('Not allowed to read contacts')
    expect(snackbar.color).toBe('error')
  })

  it('leaves to the HTTP client what it already said: a network failure, a 5xx, a 401', () => {
    expect(reportError(axiosError())).toBe(false)
    expect(reportError(axiosError(500, 'boom'))).toBe(false)
    expect(reportError(axiosError(401))).toBe(false)
    expect(snackbar.visible).toBe(false)
  })

  it('says nothing for a request its caller gave up on', () => {
    expect(reportError(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' }))).toBe(false)
    expect(snackbar.visible).toBe(false)
  })

  it('says and logs an error that is not an HTTP answer', () => {
    const log = spyOn(console, 'error').mockImplementation(() => {})
    expect(reportError(new TypeError('x is undefined'))).toBe(true)
    expect(snackbar.visible && snackbar.message).toBe('x is undefined')
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})
