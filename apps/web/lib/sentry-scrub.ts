type SentryQuery = string | Record<string, string> | Array<[string, string]>;

type ScrubbableEvent = {
  request?: {
    headers?: Record<string, string>;
    query_string?: SentryQuery;
  };
};

const SENSITIVE_QUERY_PREFIXES = ["token", "password", "secret"];

function sensitive(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_QUERY_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function decodeKey(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function scrubQuery(query: SentryQuery): SentryQuery {
  if (typeof query === "string") {
    return query
      .split("&")
      .filter(part => !sensitive(decodeKey(part.split("=", 1)[0] || "")))
      .join("&");
  }
  if (Array.isArray(query)) {
    return query.filter(([key]) => !sensitive(key));
  }
  return Object.fromEntries(Object.entries(query).filter(([key]) => !sensitive(key)));
}

export function scrubSentryEvent<T extends ScrubbableEvent>(event: T): T {
  const request = event.request;
  if (!request) {
    return event;
  }
  if (request.headers) {
    delete request.headers.authorization;
    delete request.headers.cookie;
    delete request.headers["x-api-key"];
  }
  if (request.query_string) {
    request.query_string = scrubQuery(request.query_string);
  }
  return event;
}
