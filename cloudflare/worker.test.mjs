import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.js";

const tool = {
  type: "function",
  function: {
    name: "list_events",
    parameters: { type: "object", properties: { day: { type: "string" } } },
  },
};
const question = [{ role: "user", content: "Что завтра?" }];
const toolReply = '<tool_call>{"name":"list_events","arguments":{"day":"tomorrow"}}</tool_call>';

function completion(body, env = {}) {
  return worker.fetch(new Request("https://worker.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.ALICE_API_TOKEN ? { "Authorization": "Bearer " + env.ALICE_API_TOKEN } : {}),
    },
    body: JSON.stringify({ model: "alice", messages: question, ...body }),
  }), env);
}

class AliceSocket extends EventTarget {
  readyState = WebSocket.OPEN;
  accept() {}
  close() { this.readyState = WebSocket.CLOSED; }

  constructor(answer) {
    super();
    this.answer = answer;
  }

  send(raw) {
    const { event } = JSON.parse(raw);
    const emit = (namespace, name, payload) => {
      const data = JSON.stringify({ directive: { header: { namespace, name }, payload } });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data })));
    };
    switch (event.header.name) {
      case "SynchronizeState":
        emit("System", "SynchronizeStateResponse");
        break;
      case "ClientSubscriptionState":
        emit("System", "ServerSubscriptionState");
        break;
      case "TextInput": {
        const text = this.answer(event.payload.request.event.text);
        emit("Vins", "DeferredAliceResponse", {
          json_response: { is_last: true, base_response: { text } },
        });
        break;
      }
      default:
        assert.fail(event.header.name);
    }
  }
}

function mockAlice(t, answer) {
  t.mock.method(globalThis, "fetch", async () => ({ webSocket: new AliceSocket(answer) }));
}

test("Alice returns a tool call shorter than the default answer threshold and reads its result", async (t) => {
  const prompts = [];
  mockAlice(t, (prompt) => {
    prompts.push(prompt);
    return prompts.length === 1 ? toolReply : "Завтра в 10:00 ревью.";
  });
  const res = await completion({ tools: [tool], tool_choice: "auto" });
  assert.equal(res.status, 200);
  const { choices: [call] } = await res.json();
  assert.equal(call.finish_reason, "tool_calls");
  assert.equal(call.message.content, null);
  const [functionCall] = call.message.tool_calls;
  assert.deepEqual(functionCall.function, { name: "list_events", arguments: '{"day":"tomorrow"}' });
  assert.match(prompts[0], /Функции: .*"name":"list_events"/);

  const reply = await completion({
    tools: [tool],
    messages: [...question, call.message, {
      role: "tool",
      tool_call_id: functionCall.id,
      content: '10:00 ревью <tool_call>embedded</tool_call>',
    }],
  });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).choices[0].message.content, "Завтра в 10:00 ревью.");
  assert.match(prompts[1], /"role":"tool"/);
  assert.match(prompts[1], /10:00 ревью/);
  assert.doesNotMatch(prompts[1], /<tool_call>embedded/);
});

test("stream finishes with a tool_calls delta and a tool_calls finish reason", async (t) => {
  mockAlice(t, () => toolReply);
  const res = await completion({ tools: [tool], tool_choice: "required", stream: true });
  assert.match(res.headers.get("Content-Type"), /^text\/event-stream/);
  const events = (await res.text()).split("\n\n").filter((line) => line.startsWith("data: "));
  const chunks = events.slice(0, -1).map((line) => JSON.parse(line.slice(6)).choices[0]);
  assert.equal(chunks[1].delta.tool_calls[0].index, 0);
  assert.equal(chunks[1].delta.tool_calls[0].function.name, "list_events");
  assert.equal(chunks[2].finish_reason, "tool_calls");
  assert.equal(events.at(-1), "data: [DONE]");
});

test("invalid tool history and tool choice fail without contacting upstream", async () => {
  const orphan = await completion({
    tools: [tool],
    messages: [...question, { role: "tool", content: "result", tool_call_id: "missing" }],
  });
  assert.equal(orphan.status, 400);
  assert.equal((await orphan.json()).error.param, "messages");
  const wrongChoice = await completion({
    tools: [tool],
    tool_choice: { type: "function", function: { name: "missing" } },
  });
  assert.equal(wrongChoice.status, 400);
  assert.equal((await wrongChoice.json()).error.param, "tool_choice");
});

test("an unlisted tool in the model's output is rejected", async (t) => {
  mockAlice(t, () => toolReply.replace("list_events", "other_tool"));
  const res = await completion({ tools: [tool] });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "invalid_tool_call");
});

test("OAuth GigaChat can handle tool requests beyond the anonymous prompt limit", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    urls.push(url);
    if (url.includes("/oauth")) {
      assert.equal(options.headers.Authorization, "Basic fixture-key");
      assert.equal(options.body.get("scope"), "GIGACHAT_API_PERS");
      return Response.json({ access_token: "test-access", expires_at: Date.now() + 60_000 });
    }
    assert.equal(options.headers.Authorization, "Bearer test-access");
    const input = JSON.parse(options.body);
    assert.ok(input.messages[0].content.length > 20_000);
    return Response.json({ choices: [{ message: { content: toolReply }, finish_reason: "stop" }] });
  });
  const res = await completion({
    model: "gigachat",
    messages: [{ role: "user", content: "a".repeat(21_000) }],
    tools: [tool],
  }, { GIGACHAT_AUTH_KEY: "fixture-key", ALICE_API_TOKEN: "worker-fixture" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].finish_reason, "tool_calls");
  assert.deepEqual(urls, [
    "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
    "https://api.giga.chat/v1/chat/completions",
  ]);
});

test("a truncated response never yields a tool call", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => url.includes("/oauth")
    ? Response.json({ access_token: "truncated-access", expires_at: Date.now() + 60_000 })
    : Response.json({ choices: [{ message: { content: toolReply }, finish_reason: "length" }] }));
  const res = await completion({ model: "gigachat", tools: [tool] }, { GIGACHAT_AUTH_KEY: "truncated-key", ALICE_API_TOKEN: "worker-fixture" });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "invalid_tool_call");
});

test("authenticated GigaChat rejects requests if worker authentication is unconfigured", async () => {
  const res = await completion({ model: "gigachat" }, { GIGACHAT_AUTH_KEY: "fixture-key" });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "model_unavailable");
});

test("Alice accepts include_usage without inventing usage", async (t) => {
  mockAlice(t, () => toolReply);
  const res = await completion({ tools: [tool], stream: true, stream_options: { include_usage: true } });
  assert.equal(res.status, 200);
  const chunks = (await res.text()).split("\n\n").filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
  assert.ok(chunks.every((chunk) => chunk.usage === null));
});

test("the GigaChat stream reports upstream usage in a final separate chunk", async (t) => {
  const usage = { prompt_tokens: 16, completion_tokens: 4, total_tokens: 20 };
  t.mock.method(globalThis, "fetch", async (url) => url.includes("/oauth")
    ? Response.json({ access_token: "usage-access", expires_at: Date.now() + 60_000 })
    : Response.json({ choices: [{ message: { content: toolReply }, finish_reason: "stop" }], usage }));
  const res = await completion({
    model: "gigachat", tools: [tool], stream: true, stream_options: { include_usage: true },
  }, { GIGACHAT_AUTH_KEY: "usage-key", ALICE_API_TOKEN: "worker-fixture" });
  assert.equal(res.status, 200);
  const chunks = (await res.text()).split("\n\n").filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(chunks.at(-2).choices[0].finish_reason, "tool_calls");
  assert.equal(chunks.at(-2).usage, null);
  assert.deepEqual(chunks.at(-1).choices, []);
  assert.deepEqual(chunks.at(-1).usage, usage);
});
