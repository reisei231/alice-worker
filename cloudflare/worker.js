import { ChatInputError, chatMessages, chatOutput, chatPrompt, chatTools } from "./chat-tools.js";
import { runGigachatAPI } from "./gigachat-api.js";

const aliceURL = "https://uniproxy.alice.yandex.ru/uni.ws";
const aliceOrigin = "https://alice.yandex.ru";
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 YaBrowser/26.3.0.0 Safari/537.36";
const applicationID = "ru.yandex.webstandalone.desktop";
const aliceModel = { id: "alice", object: "model", created: 0, owned_by: "yandex" };
const gigachatModel = { id: "gigachat", object: "model", created: 0, owned_by: "sber" };
const gigachatOrigin = "https://giga.chat";
const gigachatInitPath = "/api/smartproxy/api/public/gigachat/init";
const gigachatChatPath = "/api/smartproxy/api/gc-public/api/v0/sessions/request";
const gigachatSessions = [];
const maxBodyBytes = 256 * 1024;
const decoder = new TextDecoder();

// Keep these protocol fields in sync with internal/uniproxy/payload.go.
const supportedFeatures = [
  "background_response_streaming_for_dialog_controls",
  "background_response_streaming_in_read_dialog",
  "background_response_streaming_anon",
  "background_response_streaming",
  "supports_bso_answer",
  "open_link",
  "server_action",
  "show_promo",
  "reminders_and_todos",
  "div2_cards",
  "player_pause_directive",
  "can_open_dialogs_in_tabs",
  "supports_streaming_response",
  "supports_rich_json_cards",
  "builtin_reaction",
  "open_link_by_button",
  "supports_origin_in_separate_card",
  "supports_new_sources_cards",
  "supports_markdown_response",
  "supported_save_chathistory",
  "supported_load_chathistory",
  "supports_unlimited_dialogs_creation",
  "supports_multi_model_dialogs",
  "print_text_in_message_view",
  "show_loader_directive",
  "supports_stringbody_in_div2_card",
  "supports_default_dialog_as_dedicated",
  "whisper",
];
const experiments = [
  "dont_skip_cancel_requests",
  "enable_parallel_requests_to_chats",
  "read_dialogs_for_unauthorized_users",
  "mm_allow_anonymous_request",
  "enable_external_skills_for_webdesktop_and_webtouch",
  "send_show_view_directive_on_supports_show_view_layer_content_interface",
  "standalone_alice_2_0",
  "mm_enable_protocol_scenario=WebAliceControls",
  "exp_flag_chat_dialog_history",
  "exp_flag_chat_dialog_history_main_context_save",
  "div2cards_in_external_skills_for_web_standalone",
  "enable_find_poi_standalone",
  "use_server_pings",
  "enable_onboarding_adaptive_size",
  "standalone_show_fullscreen_image_gallery_directive",
  "draw_picture_enable_controls",
  "alice_has_borders_div_paddings",
  "enable_new_colors_for_alice_chat",
  "erase_serialized_response_from_json_deferred_alice_response",
  "skills_standalone_use_div_render",
  "standalone_skill_card_cloud_ui",
  "alice_enable_generate_video",
  "aliceapp_enable_generate_video",
  "alice_video_generation_soon",
  "new_input_bts",
];
const chatSupportedDirectives = [
  "ScrollToFragmentDirectiveType",
  "LoginWithCallbackDirectiveType",
  "LimitExceededBannerDirectiveType",
  "FewRequestsLeftBannerDirective",
  "ShowBannerDirectiveType",
  "ShowProPurchaseScreenDirectiveType",
  "ShowModalDirectiveType",
  "ShowNotificationDirectiveType",
  "SetChatRequestModeDirectiveType",
  "ShowFullscreenImageGalleryDirectiveType",
  "ZoomImageDirectiveType",
  "DownloadImageDirectiveType",
  "FillChatInputDirectiveType",
  "FinishChatDirectiveType",
  "CreateNewChatDirectiveType",
  "OpenChatListDirectiveType",
  "ChatNavigateBackDirectiveType",
];

function newSession() {
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const digits = crypto.getRandomValues(new Uint32Array(9)).map((value) => value % 10);
  return {
    timestamp,
    clientTime: new Date(now + 3 * 3_600_000).toISOString().slice(0, 19).replace(/[-:]/g, ""),
    deviceID: "0000000000000" + digits.join("") + timestamp,
    authToken: crypto.randomUUID(),
    dialogID: crypto.randomUUID(),
    icookie: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64)))),
  };
}

function frame(namespace, name, seqNumber, payload, messageId = crypto.randomUUID()) {
  return { event: { header: { namespace, name, seqNumber, messageId }, payload } };
}

function synchronize(session) {
  return frame("System", "SynchronizeState", 1, {
    auth_token: session.authToken,
    uuid: session.deviceID,
    vins: { application: { app_id: applicationID, platform: "windows", device_id: session.deviceID } },
    supported_features: supportedFeatures,
    request: { experiments },
    speechkitVersion: "4.16.7",
    icookie: session.icookie,
    sae_cookie: "",
    yexp_cookie: "",
    client_analytics_info: { client_url: aliceOrigin + "/" },
  });
}

function subscribe(session) {
  return frame("System", "ClientSubscriptionState", 2, {
    subscriptions: [
      { id: session.dialogID, state: { full_content: {} } },
      { id: "", state: { ping: {} } },
    ],
  });
}

function capabilities(dialogID) {
  const list = [
    { "@type": "type.googleapis.com/NAlice.TAliceCapability", meta: {}, parameters: {}, state: {} },
    {
      "@type": "type.googleapis.com/NAlice.TAliceChatCapability",
      meta: { supported_directives: chatSupportedDirectives },
      parameters: { supports_rich_answers: true, supports_rich_suggests: true, supports_rich_summary: true },
      state: {
        navigation_state: {
          topmost_navigation_entry: { id: "chat", type: "Chat", title: "Чат с Алисой", can_navigate_back: false },
        },
        active_chat_dialog_context: {
          dialog_id: dialogID, dialog_type: "DEDICATED_CHAT", alice2_mode_info: { preset: "", mode: "Pro" },
        },
      },
    },
    {
      "@type": "type.googleapis.com/NAlice.TAliceProCapability",
      meta: { supported_directives: ["OpenProPurchaseScreenDirectiveType"] },
      parameters: {}, state: {},
    },
    { "@type": "type.googleapis.com/NAlice.TBestPriceChatCapability", meta: {}, state: {} },
    { "@type": "type.googleapis.com/NAlice.TDivViewCapability", meta: {}, parameters: {}, state: {} },
  ];
  // The web protocol repeats the capability list within the same endpoint.
  return [...list, ...list];
}

function textInput(session, prompt) {
  const messageID = crypto.randomUUID();
  return frame("Vins", "TextInput", 3, {
    application: {
      app_id: applicationID,
      app_version: "unknown",
      platform: "windows",
      os_version: userAgent.toLowerCase(),
      uuid: session.deviceID,
      lang: "ru-RU",
      client_time: session.clientTime,
      timezone: "Europe/Moscow",
      timestamp: session.timestamp,
    },
    header: { request_id: messageID, dialog_id: session.dialogID, dialog_type: 2 },
    request: {
      event: { type: "text_input", text: prompt },
      voice_session: false,
      experiments,
      uniproxy_options: {
        background_response_streaming_options: { request_with_shown_new_dialog: {} },
      },
      additional_options: {
        bass_options: { user_agent: userAgent, screen_scale_factor: 1 },
        origin_domain: "yandex.ru",
        supported_features: supportedFeatures,
        unsupported_features: [],
        icookie: session.icookie,
      },
      environment_state: {
        endpoints: [{ id: session.deviceID, capabilities: capabilities(session.dialogID) }],
      },
    },
    format: "audio/ogg;codecs=opus",
    mime: "audio/webm;codecs=opus",
    topic: "desktopgeneral",
    punctuation: false,
    alice_2_settings: { preset: "", mode: "Pro" },
  }, messageID);
}

function pong(messageID) {
  return {
    event: {
      header: { namespace: "System", name: "Pong", messageId: crypto.randomUUID(), refMessageId: messageID },
      payload: {},
    },
  };
}

function parseDeferred(payload) {
  const response = payload?.json_response;
  const base = response?.base_response;
  let answer = base?.text ?? "";
  const sources = [];
  for (const card of base?.cards ?? []) {
    for (const link of card?.sources_card?.sources ?? []) {
      if (typeof link === "string" && link) sources.push({ link });
    }
    const neuro = card?.neuro_structured_blocks_card;
    if (neuro?.plain_text) answer = neuro.plain_text;
    if (!neuro?.json_source_data) continue;
    const items = JSON.parse(neuro.json_source_data) ?? [];
    if (!Array.isArray(items)) throw new Error("invalid Alice source data");
    for (const item of items) {
      if (!item?.FullUrl || item.NeedToHide) continue;
      const source = { link: item.FullUrl };
      if (item.DocumentTitle) source.anchor = item.DocumentTitle;
      if (item.Description) source.snippet = item.Description;
      sources.push(source);
    }
  }
  return { answer, sources, last: response?.is_last === true };
}

function readAnswer(socket, session, prompt, options, signal) {
  return new Promise((resolve, reject) => {
    let stage = "SynchronizeStateResponse";
    let answer = "";
    let sources = [];
    let timer;

    function resetTimer() {
      clearTimeout(timer);
      const timeout = stage === "DeferredAliceResponse" ? options.streamTimeout : options.handshakeTimeout;
      timer = setTimeout(() => finish(new Error(`Alice timed out waiting for ${stage}`)), timeout);
    }

    function finish(error) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve({ answer, sources });
    }

    const onAbort = () => finish(signal.reason);
    const onClose = (event) => finish(new Error(`Alice closed the WebSocket (${event.code})`));
    const onError = () => finish(new Error("Alice WebSocket error"));

    function onMessage(event) {
      resetTimer();
      let directive;
      try {
        const data = typeof event.data === "string" ? event.data : decoder.decode(event.data);
        directive = JSON.parse(data)?.directive;
      } catch {
        return;
      }
      const header = directive?.header;
      if (!header) return;

      try {
        if (header.namespace === "System" && header.name === "Ping") {
          socket.send(JSON.stringify(pong(header.messageId ?? "")));
        } else if (header.name === stage && header.namespace === "System" && stage === "SynchronizeStateResponse") {
          stage = "ServerSubscriptionState";
          socket.send(JSON.stringify(subscribe(session)));
        } else if (header.name === stage && header.namespace === "System" && stage === "ServerSubscriptionState") {
          stage = "DeferredAliceResponse";
          socket.send(JSON.stringify(textInput(session, prompt)));
          resetTimer();
        } else if (header.name === stage && header.namespace === "Vins" && stage === "DeferredAliceResponse") {
          const result = parseDeferred(directive.payload);
          if (result.answer) answer = result.answer;
          if (result.sources.length) sources = result.sources;
          if (result.last) finish(answer.trim() ? undefined : new Error("Alice returned an empty answer"));
        }
      } catch (error) {
        finish(error);
      }
    }

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    try {
      socket.binaryType = "arraybuffer";
      socket.accept();
      socket.send(JSON.stringify(synchronize(session)));
      resetTimer();
    } catch (error) {
      finish(error);
    }
  });
}

async function askAlice(prompt, options, signal) {
  const session = newSession();
  const dialTimeout = new AbortController();
  const timer = setTimeout(() => dialTimeout.abort(new Error("Alice WebSocket upgrade timed out")), options.handshakeTimeout);
  let response;
  try {
    response = await fetch(aliceURL, {
      headers: { Upgrade: "websocket", Origin: aliceOrigin, "User-Agent": userAgent, "Accept-Language": "ru-RU,ru;q=0.9" },
      redirect: "manual",
      signal: AbortSignal.any([signal, dialTimeout.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
  const socket = response.webSocket;
  if (!socket) {
    await response.body?.cancel();
    throw new Error(`Alice WebSocket upgrade returned HTTP ${response.status}`);
  }
  try {
    return await readAnswer(socket, session, prompt, options, signal);
  } finally {
    if (socket.readyState < WebSocket.CLOSING) socket.close(1000);
  }
}

function integer(value, fallback, minimum) {
  if (!/^[+-]?\d+$/.test(value ?? "")) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function duration(value, fallback) {
  const units = { ns: 1e-6, "µs": 1e-3, "μs": 1e-3, us: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  let rest = (value ?? "").replace(/^\+/, "");
  while (rest) {
    const match = /^(\d+(?:\.\d*)?|\.\d+)(ns|[µμu]s|ms|s|m|h)/.exec(rest);
    if (!match) return fallback;
    total += Number(match[1]) * units[match[2]];
    rest = rest.slice(match[0].length);
  }
  return total > 0 && total <= 2_147_483_647 ? Math.ceil(total) : fallback;
}

function jsonError(status, error, code, extra) {
  return Response.json({ error, code, ...extra }, { status });
}

async function readJSON(request) {
  if (!request.body) throw new Error("missing JSON body");
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBodyBytes);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.length > maxBodyBytes - size) {
        await reader.cancel();
        throw new Error("body exceeds 256 KiB");
      }
      bytes.set(value, size);
      size += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(decoder.decode(bytes.subarray(0, size)));
}

function authorized(request, env) {
  const auth = request.headers.get("Authorization");
  return !env.ALICE_API_TOKEN || (auth?.startsWith("Bearer ") && auth.slice(7).trim() === env.ALICE_API_TOKEN);
}

async function runQuery(request, env, prompt, { tools = false } = {}) {
  const options = {
    maxAttempts: integer(env.ALICE_MAX_ATTEMPTS, 3, 1),
    minAnswerLen: tools ? 1 : integer(env.ALICE_MIN_ANSWER_LEN, 140, 0),
    handshakeTimeout: duration(env.ALICE_HANDSHAKE_TIMEOUT, 15_000),
    streamTimeout: duration(env.ALICE_STREAM_TIMEOUT, 90_000),
    queryTimeout: duration(env.ALICE_QUERY_TIMEOUT, 120_000),
  };

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("query timed out")), 300_000);
  const requestSignal = AbortSignal.any([request.signal, deadline.signal]);
  let lastError;
  try {
    for (let attempts = 1; attempts <= options.maxAttempts; attempts++) {
      const attempt = new AbortController();
      const timeout = setTimeout(() => attempt.abort(new Error("Alice attempt timed out")), options.queryTimeout);
      try {
        requestSignal.throwIfAborted();
        const signal = AbortSignal.any([requestSignal, attempt.signal]);
        const { answer, sources } = await askAlice(prompt, options, signal);
        const length = [...answer].length;
        if (length < options.minAnswerLen) {
          throw new Error(`answer shorter than threshold: got ${length}, want at least ${options.minAnswerLen}`);
        }
        return { answer, sources, attempts };
      } catch (error) {
        if (deadline.signal.aborted) return { status: 504, error: "query timed out", code: "timeout" };
        if (request.signal.aborted) return { status: 408, error: "query canceled", code: "canceled" };
        lastError = error.message;
      } finally {
        clearTimeout(timeout);
      }
    }
    return {
      status: 502,
      error: "all attempts failed",
      code: "exhausted",
      attempts: options.maxAttempts,
      last_error: lastError,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function query(request, env) {
  if (!authorized(request, env)) return jsonError(401, "unauthorized", "auth");
  let input;
  try {
    input = await readJSON(request);
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) => key !== "prompt") ||
        (input.prompt != null && typeof input.prompt !== "string")) {
      throw new Error("expected an object with a string prompt");
    }
  } catch (error) {
    return jsonError(400, `invalid json: ${error.message}`, "bad_request");
  }
  const prompt = input.prompt ?? "";
  if (!prompt.trim()) return jsonError(400, "prompt is empty", "bad_request");
  const { status = 200, ...body } = await runQuery(request, env, prompt);
  return Response.json(body, { status });
}

function openAIError(status, message, code, param = null) {
  let type = "invalid_request_error";
  if (status === 429) type = "rate_limit_error";
  if (status >= 500) type = "server_error";
  return Response.json({ error: { message, type, param, code } }, { status });
}

class GigachatError extends Error {
  constructor(status, message, code = "upstream", retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function gigachatBaseURL(env) {
  try {
    const url = new URL(env.GIGACHAT_BASE_URL || gigachatOrigin);
    const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function gigachatHeaders(origin, deviceID, requestID) {
  return {
    "Origin": origin,
    "Referer": origin + "/",
    "X-Device-Id": deviceID,
    "X-Request-Id": requestID,
  };
}

async function checkGigachatResponse(response, stage) {
  if (response.status === 200) return;
  await response.body?.cancel();
  if (response.status === 429) throw new GigachatError(429, "GigaChat rate limit exceeded", "rate_limited");
  if (response.status === 401 || response.status === 403) {
    throw new GigachatError(502, `GigaChat ${stage} returned HTTP ${response.status}`, "upstream_auth", stage === "chat");
  }
  throw new GigachatError(502, `GigaChat ${stage} returned HTTP ${response.status}`, "upstream", response.status >= 500);
}

function gigachatCookieExpiry(cookie) {
  try {
    const payload = cookie.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const { exp } = JSON.parse(atob(payload));
    return Number.isFinite(exp) ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function openGigachatSession(origin, signal) {
  const deviceID = crypto.randomUUID();
  const response = await fetch(origin + gigachatInitPath, {
    method: "POST",
    headers: {
      ...gigachatHeaders(origin, deviceID, crypto.randomUUID()),
      "X-Application-Name": "gigachat-b2c-web",
      "X-Application-Version": "0.95.4",
      "Accept": "application/json, text/plain, */*",
    },
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  await checkGigachatResponse(response, "session initialization");
  const cookies = response.headers.getSetCookie().map((header) => header.split(";", 1)[0]);
  await response.body?.cancel();
  const token = cookies.find((cookie) => cookie.startsWith("_sd_public="));
  const sticky = cookies.find((cookie) => cookie.startsWith("sticky_cookie_km="));
  const expiresAt = token ? gigachatCookieExpiry(token.slice("_sd_public=".length)) : 0;
  if (!sticky || expiresAt <= Date.now()) {
    throw new GigachatError(502, "GigaChat returned an invalid session", "upstream_auth");
  }
  return { origin, deviceID, expiresAt, cookie: `${token}; ${sticky}` };
}

function takeGigachatSession(origin) {
  const cutoff = Date.now() + 30_000;
  for (let index = gigachatSessions.length - 1; index >= 0; index--) {
    const session = gigachatSessions[index];
    if (session.origin === origin && session.expiresAt > cutoff) {
      gigachatSessions.splice(index, 1);
      return session;
    }
    if (session.expiresAt <= cutoff) gigachatSessions.splice(index, 1);
  }
  return null;
}

async function readGigachatSSE(body, resetIdleTimeout) {
  const decoder = new TextDecoder();
  const deltas = [];
  let pending = "";
  let finalAnswer = "";
  let bytes = 0;

  function processLine(line) {
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return true;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return false;
    }
    if (event?.status === "ERROR") {
      throw new GigachatError(502, "GigaChat stream reported an error", "upstream", true);
    }
    if (typeof event?.delta === "string") deltas.push(event.delta);
    const message = event?.message;
    if (["ACTIVE", "READY", "DONE"].includes(message?.status) && typeof message.value === "string") {
      finalAnswer = message.value;
    }
    return ["READY", "DONE"].includes(event?.status) || event?.finish_reason != null;
  }

  stream: for await (const chunk of body) {
    resetIdleTimeout();
    bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new GigachatError(502, "GigaChat response exceeds the size limit");
    const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (processLine(line)) {
        pending = "";
        break stream;
      }
    }
  }
  if (pending) processLine(pending + decoder.decode());
  const answer = finalAnswer || deltas.join("");
  if (!answer.trim()) throw new GigachatError(502, "GigaChat returned no answer", "upstream", true);
  return answer;
}

async function askGigachat(session, prompt, requestID, signal) {
  const idle = new AbortController();
  let idleTimer;
  function resetIdleTimeout() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(), 20_000);
  }
  try {
    const response = await fetch(session.origin + gigachatChatPath, {
      method: "POST",
      headers: {
        ...gigachatHeaders(session.origin, session.deviceID, requestID),
        "X-Project-Id": session.deviceID,
        "X-Sm-User-Id": session.deviceID,
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
        "Cookie": session.cookie,
      },
      body: JSON.stringify({ text: prompt, featureFlags: [] }),
      redirect: "manual",
      signal: AbortSignal.any([signal, idle.signal, AbortSignal.timeout(60_000)]),
    });
    await checkGigachatResponse(response, "chat");
    if (!response.body || !response.headers.get("Content-Type")?.startsWith("text/event-stream")) {
      await response.body?.cancel();
      throw new GigachatError(502, "GigaChat returned an invalid chat stream");
    }
    resetIdleTimeout();
    return await readGigachatSSE(response.body, resetIdleTimeout);
  } catch (error) {
    if (idle.signal.aborted) throw new GigachatError(504, "GigaChat stream timed out", "timeout", true);
    throw error;
  } finally {
    clearTimeout(idleTimer);
  }
}

async function runGigachatQuery(request, env, prompt) {
  const origin = gigachatBaseURL(env);
  if (!origin) return { status: 503, error: "GigaChat upstream URL is invalid", code: "model_unavailable" };
  if (new TextEncoder().encode(prompt).length > 20_000) {
    return { status: 400, error: "GigaChat prompt exceeds 20,000 bytes", code: "bad_request" };
  }

  const deadline = AbortSignal.timeout(300_000);
  const signal = AbortSignal.any([request.signal, deadline]);
  const requestID = crypto.randomUUID();
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      signal.throwIfAborted();
      const session = takeGigachatSession(origin) ?? await openGigachatSession(origin, signal);
      const answer = await askGigachat(session, prompt, requestID, signal);
      if (session.expiresAt > Date.now() + 30_000 && gigachatSessions.length < 4) {
        gigachatSessions.push(session);
      }
      return { answer };
    } catch (error) {
      if (request.signal.aborted) return { status: 408, error: "GigaChat request canceled", code: "canceled" };
      if (deadline.aborted) return { status: 504, error: "GigaChat request timed out", code: "timeout" };
      const failure = error instanceof GigachatError ? error : error.name === "TimeoutError"
        ? new GigachatError(504, "GigaChat request timed out", "timeout", true)
        : new GigachatError(502, "GigaChat request failed", "upstream", true);
      if (attempt >= maxAttempts || !failure.retryable) {
        return { status: failure.status, error: failure.message, code: failure.code };
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
}

function chatResponse({ content, toolCall }, model, { stream, includeUsage, truncated, usage }) {
  const id = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "");
  const created = Math.floor(Date.now() / 1000);
  const metadata = { id, created, model };
  const finish = toolCall ? "tool_calls" : truncated ? "length" : "stop";
  const message = { role: "assistant", content, refusal: null };
  if (toolCall) message.tool_calls = [toolCall];
  if (!stream) {
    return Response.json({
      ...metadata,
      object: "chat.completion",
      ...(usage ? { usage } : {}),
      choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
    });
  }

  function event(choices, counts = null) {
    return "data: " + JSON.stringify({
      ...metadata,
      object: "chat.completion.chunk",
      choices,
      ...(includeUsage ? { usage: counts } : {}),
    }) + "\n\n";
  }

  function chunk(delta, finishReason = null) {
    return event([{ index: 0, delta, finish_reason: finishReason, logprobs: null }]);
  }
  // Both backends provide final text to this adapter.
  const delta = toolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : { content };
  const body = chunk({ role: "assistant", content: "" }) +
    chunk(delta) + chunk({}, finish) +
    (includeUsage && usage ? event([], usage) : "") + "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

async function chat(request, env) {
  if (!authorized(request, env)) return openAIError(401, "Invalid API key", "invalid_api_key");
  let input;
  try {
    input = await readJSON(request);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("expected a JSON object");
    }
  } catch (error) {
    return openAIError(400, error.message, "invalid_json");
  }
  if (typeof input.model !== "string" || !input.model) {
    return openAIError(400, "model is required", "missing_required_parameter", "model");
  }
  if (input.model !== aliceModel.id && input.model !== gigachatModel.id) {
    return openAIError(404, "Model not found", "model_not_found", "model");
  }

  for (const [param, supported] of [
    ["stream", input.stream == null || typeof input.stream === "boolean"],
    ["n", input.n == null || input.n === 1],
    ["parallel_tool_calls", input.parallel_tool_calls == null || typeof input.parallel_tool_calls === "boolean"],
    ["functions", input.functions == null],
    ["function_call", input.function_call == null || input.function_call === "none"],
    ["response_format", input.response_format == null || input.response_format.type === "text"],
    ["modalities", input.modalities == null || (Array.isArray(input.modalities) &&
      input.modalities.length === 1 && input.modalities[0] === "text")],
    ["stream_options", input.stream_options == null || (input.stream === true &&
      typeof input.stream_options === "object" && !Array.isArray(input.stream_options) &&
      (input.stream_options.include_usage == null || typeof input.stream_options.include_usage === "boolean"))],
    ["logprobs", input.logprobs == null || input.logprobs === false],
  ]) {
    if (!supported) return openAIError(400, `Unsupported value for ${param}`, "unsupported_value", param);
  }

  let tools;
  let prompt;
  try {
    tools = chatTools(input);
    prompt = chatPrompt(chatMessages(input.messages), tools);
  } catch (error) {
    if (!(error instanceof ChatInputError)) throw error;
    return openAIError(400, error.message, "invalid_" + error.param, error.param);
  }
  let result;
  if (input.model === gigachatModel.id) {
    if (env.GIGACHAT_AUTH_KEY && !env.ALICE_API_TOKEN) {
      return openAIError(503, "The authenticated GigaChat route requires worker authentication", "model_unavailable");
    }
    result = env.GIGACHAT_AUTH_KEY
      ? await runGigachatAPI(request, env, prompt)
      : await runGigachatQuery(request, env, prompt);
  } else {
    result = await runQuery(request, env, prompt, { tools: tools.offered.size > 0 });
  }
  if (result.error) return openAIError(result.status, result.error, result.code);
  try {
    if (result.truncated && tools.offered.size) {
      return openAIError(502, "The model response was truncated before a tool decision could be read", "invalid_tool_call");
    }
    const output = chatOutput(result.answer, tools);
    return chatResponse(output, input.model, {
      stream: input.stream,
      includeUsage: input.stream_options?.include_usage === true,
      truncated: result.truncated,
      usage: result.usage,
    });
  } catch (error) {
    return openAIError(502, error.message, "invalid_tool_call");
  }
}

export default {
  async fetch(request, env) {
    switch (new URL(request.url).pathname) {
      case "/healthz":
        if (request.method === "GET" || request.method === "HEAD") {
          return new Response(request.method === "HEAD" ? null : "ok");
        }
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      case "/query":
        if (request.method === "POST") return query(request, env);
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      case "/v1/models":
        if (request.method !== "GET") {
          return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
        }
        if (!authorized(request, env)) return openAIError(401, "Invalid API key", "invalid_api_key");
        return Response.json({
          object: "list",
          data: [aliceModel, gigachatModel],
        });
      case "/v1/chat/completions":
        if (request.method === "POST") return chat(request, env);
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      default:
        return new Response("Not Found", { status: 404 });
    }
  },
};
