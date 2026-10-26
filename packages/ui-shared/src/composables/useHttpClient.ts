import axios, { type AxiosInstance } from 'axios'
import { useSnackbar } from './useSnackbar'
import { getToken, recoverFrom401 } from '../session/session'
import { portalHref } from '../nav/navigate'
import { currentReturnPath, signInPath } from '../nav/return-path'

/**
 * Factory function to create a configured HTTP client with auth interceptors.
 * Each app can call this with its own baseURL (e.g., 'http://localhost:4010/api').
 * The default baseURL is '/api' for backward compatibility.
 */
export function createHttpClient(baseURL = '/api'): AxiosInstance {
  const client = axios.create({
    baseURL,
    headers: {
      'Content-Type': 'application/json',
    },
  })

  // Request interceptor: send THIS tab's session as a bearer token (multi-org: each tab has its own).
  client.interceptors.request.use(
    (config) => {
      const token = getToken()
      if (token) {
        config.headers.Authorization = `Bearer ${token}`
      }
      return config
    },
    (error) => Promise.reject(error)
  )

  // Response interceptor: on 401, sign this tab out (only this tab); show snackbar for other errors
  client.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 401) {
        const sent = String(error.config?.headers?.Authorization ?? '').replace(/^Bearer\s+/i, '')
        if (recoverFrom401(sent)) {
          // This tab still has a session: a newer token for the same org, or the refusal was about
          // a token it no longer holds. Reload so every view runs on the token it has now.
          if (sent && sent !== getToken()) window.location.reload()
        } else if (!window.location.pathname.startsWith('/auth')) {
          // To the portal's sign-in, which brings the person back to this page (FR-22.53).
          window.location.href = portalHref(signInPath(currentReturnPath()))
        }
      } else if (!error.response || error.response.status >= 500) {
        // Only show snackbar for server errors (5xx) and network failures.
        // 4xx errors are handled by the calling code (forms, views).
        const message = error.response?.data?.message || error.message || 'An unexpected error occurred'
        const { showError } = useSnackbar()
        showError(message)
      }
      return Promise.reject(error)
    }
  )

  return client
}

// Default singleton for backward compatibility (baseURL: '/api')
export const httpClient = createHttpClient()

export function useHttpClient() {
  return { http: httpClient }
}
