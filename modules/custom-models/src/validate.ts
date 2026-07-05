const RESERVED_PROVIDER_IDS = new Set(["__proto__", "prototype", "constructor"]);
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateProviderId(providerId: string): void {
  if (providerId.trim() !== providerId || !PROVIDER_ID_PATTERN.test(providerId) || RESERVED_PROVIDER_IDS.has(providerId.toLowerCase())) {
    throw new Error("providerId must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved JavaScript object key");
  }
}

export function validateBaseUrl(baseUrl: string): void {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("baseUrl must be an http(s) URL");
    if (parsed.username || parsed.password) throw new Error("baseUrl must not include embedded credentials");
    if (parsed.search || parsed.hash) throw new Error("baseUrl must not include query strings or fragments");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("baseUrl")) throw error;
    throw new Error("baseUrl must be a valid URL");
  }
}

export function validateModelSlug(slug: string): void {
  if (slug.trim() !== slug || slug.length === 0) throw new Error("model slug must be a non-empty trimmed string");
  if (slug.startsWith("/") || slug.endsWith("/")) throw new Error(`model slug "${slug}" must not start or end with "/"`);
  if (/[\r\n]/.test(slug)) throw new Error(`model slug "${slug}" must not contain line breaks`);
}

export function validateEnvHttpHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_PATTERN.test(name)) throw new Error(`invalid HTTP header name "${name}"`);
    if (!ENV_NAME_PATTERN.test(value)) throw new Error(`header "${name}" must map to an environment variable name`);
  }
}

