export interface Env {
  APP_ORIGIN: string;
  AWS_REGION: string;
  COGNITO_USER_POOL_ID: string;
  COGNITO_USER_POOL_CLIENT_ID: string;
  COGNITO_DOMAIN: string;
  DB: D1Database;
  EMAIL_QUEUE: Queue;
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
}

export interface RegistrationStatusRecord {
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  lookup_code: string;
  submitted_at: string;
  event_name: string;
  event_date: string | null;
  duck_keep_preference: string;
}

export interface DuckRecord {
  visible_number: number;
  tag_status: string;
}

export interface PublicRaceStatusRecord {
  first_name: string;
  last_name: string;
  registration_status: string;
  event_name: string;
  event_status: string;
  visible_number: number | null;
  round_type: string | null;
  heat_number: number | null;
  heat_status: string | null;
  current_heat_number: number | null;
  current_heat_round: string | null;
  result_position: number | null;
  advanced: number | null;
}
