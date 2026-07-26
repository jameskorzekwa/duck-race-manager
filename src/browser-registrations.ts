const cookieName = "__Host-quickducks-registrations";
const maxRegistrations = 12;

export interface BrowserRegistration {
  name: string;
  lookupCode: string;
  statusPath: string;
}

const isBrowserRegistration = (value: unknown): value is BrowserRegistration => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrowserRegistration>;
  return typeof candidate.name === "string"
    && candidate.name.length >= 1
    && candidate.name.length <= 161
    && typeof candidate.lookupCode === "string"
    && /^[A-HJ-NP-Z2-9]{8}$/.test(candidate.lookupCode)
    && typeof candidate.statusPath === "string"
    && /^\/r\/[A-Za-z0-9_-]{43,128}$/.test(candidate.statusPath);
};

export const readBrowserRegistrations = (cookieHeader: string | null): BrowserRegistration[] => {
  if (cookieHeader === null) return [];
  const encoded = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (encoded === undefined) return [];

  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(encoded));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isBrowserRegistration).slice(-maxRegistrations);
  } catch {
    return [];
  }
};

export const registrationCookie = (
  cookieHeader: string | null,
  registration: BrowserRegistration,
): string => {
  const existing = readBrowserRegistrations(cookieHeader)
    .filter((item) => item.statusPath !== registration.statusPath);
  const registrations = [...existing, registration].slice(-maxRegistrations);
  const value = encodeURIComponent(JSON.stringify(registrations));
  return `${cookieName}=${value}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`;
};
