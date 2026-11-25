const oauthURL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const chatURL = "https://api.giga.chat/v1/chat/completions";
const supportedScopes = new Set(["GIGACHAT_API_PERS", "GIGACHAT_API_B2B", "GIGACHAT_API_CORP"]);
let cachedToken;

class APIError extends Error {
  constructor(status, message, code = "upstream") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readResponse(response, step) {
  if (response.ok) return response.json();
  await response.body?.cancel();
  if (response.status === 429) throw new APIError(429, "GigaChat API rate limit exceeded", "rate_limited");
  if (response.status === 401 || response.status === 403) {
    throw new APIError(502, `GigaChat API ${step} returned HTTP ${response.status}`, "upstream_auth");
  }
  throw new APIError(502, `GigaChat API ${step} returned HTTP ${response.status}`);
}

async function accessToken(key, scope, signal) {
  if (cachedToken?.key === key && cachedToken.scope === scope &&
      cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;
  const response = await fetch(oauthURL, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + key,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "RqUID": crypto.randomUUID(),
    },
    body: new URLSearchParams({ scope }),
    redirect: "error",
    signal,
  });
  const data = await readResponse(response, "OAuth");
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new APIError(502, "GigaChat API returned no access token", "upstream_auth");
  }
  const expiry = Number(data.expires_at);
  const expiresAt = expiry < 1e12 ? expiry * 1000 : expiry;
  cachedToken = { key, scope, token: data.access_token, expiresAt };
  return data.access_token;
}

export async function runGigachatAPI(request, env, prompt) {
  const scope = env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";
  if (!supportedScopes.has(scope)) {
    return { status: 503, error: "GIGACHAT_SCOPE is invalid", code: "model_unavailable" };
  }
  const deadline = AbortSignal.timeout(60_000);
  const signal = AbortSignal.any([request.signal, deadline]);
  try {
    const key = env.GIGACHAT_AUTH_KEY;
    let token = await accessToken(key, scope, signal);
    const body = JSON.stringify({
      model: env.GIGACHAT_MODEL || "GigaChat",
      messages: [{ role: "user", content: prompt }],
      stream: false,
      function_call: "none",
    });
    const complete = () => fetch(chatURL, {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body,
      redirect: "error",
      signal,
    });
    let response = await complete();
    if (response.status === 401) {
      await response.body?.cancel();
      if (cachedToken?.token === token) cachedToken = undefined;
      token = await accessToken(key, scope, signal);
      response = await complete();
    }
    const data = await readResponse(response, "chat");
    const choice = data.choices?.[0];
    const answer = choice?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) {
      throw new APIError(502, "GigaChat API returned no answer");
    }
    const { prompt_tokens, completion_tokens, total_tokens } = data.usage ?? {};
    const validUsage = [prompt_tokens, completion_tokens, total_tokens]
      .every((count) => Number.isSafeInteger(count) && count >= 0);
    return {
      answer,
      truncated: choice.finish_reason === "length",
      usage: validUsage ? { prompt_tokens, completion_tokens, total_tokens } : undefined,
    };
  } catch (error) {
    if (request.signal.aborted) return { status: 408, error: "GigaChat request canceled", code: "canceled" };
    if (deadline.aborted) return { status: 504, error: "GigaChat request timed out", code: "timeout" };
    if (error instanceof APIError) return { status: error.status, error: error.message, code: error.code };
    return { status: 502, error: "GigaChat API request failed", code: "upstream" };
  }
}
