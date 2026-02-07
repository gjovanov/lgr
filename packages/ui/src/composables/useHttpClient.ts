import axios from 'axios'

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

// Response interceptor: on 401, clear token and redirect to login
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
    }
    return Promise.reject(error)
  }
)
