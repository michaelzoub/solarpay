const API_KEY_STORAGE = "solarpay-api-key";

export function savedApiKey() { return localStorage.getItem(API_KEY_STORAGE) || "change-me-in-production"; }
export function saveApiKey(value) { localStorage.setItem(API_KEY_STORAGE, value); }

export async function request(path, options = {}, apiKey = savedApiKey()) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { code: data.code, recovery: data.recovery });
  return data;
}

export async function adminRequest(path, options = {}, adminKey) {
  const response = await fetch(`/api/admin${path}`, {
    ...options,
    headers: { "content-type": "application/json", "x-admin-key": adminKey, ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
