const credentialPath = /(\/(?:api\/v1\/staff\/ducks|api\/v1\/ducks|staff\/ducks|t|r)\/)[A-Za-z0-9_-]{22,128}|(\/api\/v1\/registrations\/)[A-Za-z0-9_-]{40,128}/g;

export const redactE2eOutput = (line) => line.replace(
  credentialPath,
  (_match, prefix, registrationPrefix) => `${prefix ?? registrationPrefix}[redacted]`,
);
