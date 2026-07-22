import dashboard from "../../dist/server/index.js";

function envObject(context) {
  const env = {};
  if (globalThis.Deno?.env?.toObject) {
    Object.assign(env, globalThis.Deno.env.toObject());
  }
  const contextEnv = context?.env;
  if (contextEnv?.toObject) {
    Object.assign(env, contextEnv.toObject());
  }
  if (contextEnv?.get) {
    [
      "EVENT_INGEST_KEY",
      "MANYCHAT_API_KEY",
      "MANYCHAT_API_KEY_FB1177107122151553",
      "MANYCHAT_API_KEY_FB701760706347255",
      "WEBHOOK_URL",
      "AUTH_ENABLED",
      "AUTH_EMAIL",
      "AUTH_PASSWORD",
      "AUTH_PASSWORD_HASH",
      "AUTH_SESSION_SECRET"
    ].forEach(name => {
      const value = contextEnv.get(name);
      if (value !== undefined && value !== null) env[name] = value;
    });
  }
  return env;
}

export default async function handler(request, context) {
  return dashboard.fetch(request, envObject(context));
}

export const config = {
  path: "/*"
};
