export interface Env {
  APP_ORIGIN: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_REGION: string;
  AWS_SECRET_ACCESS_KEY: string;
  EMAIL_FROM_ADDRESS: string;
  SMS_ORIGINATION_IDENTITY?: string;
  SMS_OPT_OUT_LIST_NAME?: string;
  NOTIFICATION_SIGNING_SECRET?: string;
  COGNITO_USER_POOL_ID: string;
  COGNITO_USER_POOL_CLIENT_ID: string;
  COGNITO_DOMAIN: string;
  DB: D1Database;
  EMAIL_QUEUE: Queue;
  PARTICIPANT_CONTACT_READ_RATE_LIMITER: RateLimit;
  PUBLIC_SEARCH_RATE_LIMITER: RateLimit;
  RACE_UPDATES?: DurableObjectNamespace;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export interface EventRecord {
  id: string;
  slug: string;
  name: string;
  event_date: string | null;
  timezone: string;
  status: string;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  email_required: number;
  public_name_policy: "FIRST_NAME_ONLY" | "FIRST_NAME_LAST_INITIAL" | "FULL_NAME";
}

export interface RegistrationStatusRecord {
  first_name: string;
  last_name: string;
  status: string;
  lookup_code: string;
  submitted_at: string;
  event_name: string;
  event_date: string | null;
}

export interface DuckRecord {
  visible_number: number;
  tag_status: string;
}
