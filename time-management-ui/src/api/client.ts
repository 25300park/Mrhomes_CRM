const API_ROOT = '/api/time-management'
const CRM_LOGIN_PATH = '/'

type FetchFunction = typeof fetch

export type ApiClientErrorDetails = {
  code: string
  message: string
  requestId?: string
  status: number
}

export class ApiClientError extends Error {
  readonly code: string
  readonly requestId?: string
  readonly status: number

  constructor({ code, message, requestId, status }: ApiClientErrorDetails) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.requestId = requestId
    this.status = status
  }
}

type ApiClientOptions = {
  fetchFn?: FetchFunction
  getCsrfToken?: () => Promise<string>
  redirectToLogin?: (path: string) => void
}

type ApiErrorBody = {
  error?: {
    code?: unknown
    message?: unknown
    requestId?: unknown
  }
}

function apiPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Time management API paths must be relative.')
  }
  return `${API_ROOT}${path}`
}

function isMutation(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method)
}

function toApiError(status: number, body: ApiErrorBody | undefined): ApiClientError {
  const error = body?.error
  return new ApiClientError({
    code: typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED',
    message: typeof error?.message === 'string' ? error.message : 'Time management request failed.',
    requestId: typeof error?.requestId === 'string' ? error.requestId : undefined,
    status
  })
}

async function parseJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!contentType.includes('application/json')) return undefined
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function browserLoginRedirect(path: string): void {
  window.location.assign(path)
}

function createCsrfTokenGetter(fetchFn: FetchFunction, redirectToLogin: (path: string) => void): () => Promise<string> {
  return async () => {
    const response = await fetchFn(apiPath('/csrf'), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      method: 'GET'
    })
    const body = await parseJson(response) as { csrfToken?: unknown } | undefined
    if (!response.ok) {
      if (response.status === 401) redirectToLogin(CRM_LOGIN_PATH)
      throw toApiError(response.status, body as ApiErrorBody | undefined)
    }
    if (typeof body?.csrfToken !== 'string' || body.csrfToken.length === 0) {
      throw new ApiClientError({ code: 'CSRF_UNAVAILABLE', message: 'CSRF token is unavailable.', status: 500 })
    }
    return body.csrfToken
  }
}

export function createApiClient(options: ApiClientOptions = {}) {
  const fetchFn = options.fetchFn ?? window.fetch.bind(window)
  const redirectToLogin = options.redirectToLogin ?? browserLoginRedirect
  const getCsrfToken = options.getCsrfToken ?? createCsrfTokenGetter(fetchFn, redirectToLogin)

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const init: RequestInit = { credentials: 'same-origin', headers, method }

    if (isMutation(method)) {
      headers['X-CSRF-Token'] = await getCsrfToken()
      headers['Content-Type'] = 'application/json'
      if (body !== undefined) init.body = JSON.stringify(body)
    }

    const response = await fetchFn(apiPath(path), init)
    const responseBody = await parseJson(response)
    if (!response.ok) {
      const error = toApiError(response.status, responseBody as ApiErrorBody | undefined)
      if (response.status === 401) redirectToLogin(CRM_LOGIN_PATH)
      throw error
    }
    return responseBody as T
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
    delete: <T>(path: string) => request<T>('DELETE', path)
  }
}

export const apiClient = createApiClient()
