import axios from 'axios'
import { useSnackbar } from './useSnackbar'

export function useHttpClient() {
  return { http: httpClient }
}

export const httpClient = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor: add Authorization header from localStorage
httpClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('lgr_token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

// Response interceptor: on 401, clear token and redirect to login; show snackbar for other errors
httpClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('lgr_token')
      localStorage.removeItem('lgr_org')
      // Only redirect if not already on auth pages
      if (!window.location.pathname.startsWith('/auth')) {
        window.location.href = '/auth/login'
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
