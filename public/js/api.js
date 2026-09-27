let onUnauthorized = () => {};

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(method, path, body) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('无法连接到管理程序，请确认程序仍在运行', 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON error page
  }
  if (res.status === 401 && data?.code === 'unauthorized') onUnauthorized();
  if (!res.ok) throw new ApiError(data?.error || `请求失败（HTTP ${res.status}）`, res.status, data?.code);
  return data;
}

export const GET = (path) => api('GET', path);
export const POST = (path, body) => api('POST', path, body);
export const PUT = (path, body) => api('PUT', path, body);
export const PATCH = (path, body) => api('PATCH', path, body);
export const DELETE = (path) => api('DELETE', path);
