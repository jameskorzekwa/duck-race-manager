export interface RegistrationInput {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  emailNotificationsEnabled: boolean;
}

export interface RegistrationValidation {
  value?: RegistrationInput;
  errors: Record<string, string>;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const tokenAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const cleanName = (value: string | File | null): string =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

const cleanOptional = (value: string | File | null): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned === "" ? null : cleaned;
};

export const validateRegistration = (
  form: FormData,
  emailRequired: boolean,
): RegistrationValidation => {
  const firstName = cleanName(form.get("first_name"));
  const lastName = cleanName(form.get("last_name"));
  const email = cleanOptional(form.get("email"))?.toLowerCase() ?? null;
  const phone = cleanOptional(form.get("phone"));
  const errors: Record<string, string> = {};

  if (firstName.length === 0) errors.first_name = "Enter a first name.";
  if (firstName.length > 80) errors.first_name = "Use 80 characters or fewer.";
  if (lastName.length === 0) errors.last_name = "Enter a last name.";
  if (lastName.length > 80) errors.last_name = "Use 80 characters or fewer.";

  if (emailRequired && email === null) errors.email = "Email is required for this race.";
  if (email !== null && (email.length > 254 || !emailPattern.test(email))) {
    errors.email = "Enter a valid email address.";
  }

  if (phone !== null && phone.length > 32) errors.phone = "Use 32 characters or fewer.";

  if (Object.keys(errors).length > 0) return { errors };

  return {
    errors,
    value: {
      firstName,
      lastName,
      email,
      phone,
      emailNotificationsEnabled: email !== null && form.get("email_notifications_enabled") === "on",
    },
  };
};

export const randomToken = (byteLength = 32): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const randomLookupCode = (length = 8): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => tokenAlphabet[byte % tokenAlphabet.length]).join("");
};

export const hashToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const isPrivateToken = (value: string): boolean => /^[A-Za-z0-9_-]{43,128}$/.test(value);

export const isCommandId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
