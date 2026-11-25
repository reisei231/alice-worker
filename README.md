# alice-worker

The [Worker module](cloudflare/worker.js) connects directly to Yandex Alice
and GigaChat. It serves `GET /healthz`, `POST /query`, `GET /v1/models`, and
`POST /v1/chat/completions`.

From the repository root, use Node.js 22.12 or newer to run or build the Worker:

```sh
npx wrangler@4.166.0 dev
npx wrangler@4.166.0 deploy --dry-run --outdir dist/cloudflare
```

For deployment, sign in to Wrangler and deploy using the included
[`wrangler.jsonc`](wrangler.jsonc). To enable Bearer authentication from the
first deployment, put `ALICE_API_TOKEN=<your-token>` in a local `.env.production`
file and run:

```sh
npx wrangler@4.166.0 login
npx wrangler@4.166.0 deploy --secrets-file .env.production
```

For a dashboard deployment, use the bundled output from the Wrangler dry run
and the compatibility date and flags from `wrangler.jsonc`.
Add `ALICE_API_TOKEN` as a secret under **Settings → Variables and Secrets**.
`/healthz` stays public. With the token unset, the other endpoints also accept
requests without authentication.

The Worker accepts the same `ALICE_MAX_ATTEMPTS`, `ALICE_MIN_ANSWER_LEN`,
`ALICE_HANDSHAKE_TIMEOUT`, `ALICE_STREAM_TIMEOUT`, and `ALICE_QUERY_TIMEOUT`
settings as the Go server. Set these as text variables if you need to override the defaults.

### GigaChat

Use `model: "gigachat"` to call GigaChat. The Worker opens an anonymous session
with `https://giga.chat` and reads the provider's SSE reply. It reuses up to four
idle sessions within the same isolate until they approach expiry. Sessions are
created as needed and are kept in memory for the lifetime of the isolate.

`GET /v1/models` lists both `alice` and `gigachat`. The Worker uses
`ALICE_API_TOKEN` for client authentication with either model. For local
protocol testing, set `GIGACHAT_BASE_URL` to the origin of a fixture that
implements the GigaChat session and chat endpoints.

If GigaChat rejects anonymous session initialization, the completion endpoint
returns HTTP `502` with the OpenAI error code `upstream_auth`. Set
`GIGACHAT_AUTH_KEY` and `ALICE_API_TOKEN` as Worker secrets to use the authenticated
GigaChat API.
`GIGACHAT_SCOPE` defaults to `GIGACHAT_API_PERS`. Set `GIGACHAT_MODEL` to select
the upstream model, which defaults to `GigaChat`. The 20,000-byte prompt limit
applies to the anonymous route.

### OpenAI-compatible chat

Set the client base URL to your Worker URL with `/v1` appended, the model to
`alice` or `gigachat`, and the API key to the value of `ALICE_API_TOKEN`.

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://alice-runner.YOUR_SUBDOMAIN.workers.dev/v1",
  apiKey: process.env.ALICE_API_TOKEN,
});

const completion = await client.chat.completions.create({
  model: "alice",
  messages: [{ role: "user", content: "Explain how the QUIC protocol works." }],
});
console.log(completion.choices[0].message.content);
```

Chat completions accept text messages and return one choice. With `stream: true`,
the Worker sends OpenAI-compatible SSE events after the backend returns its
answer. For function calling, send OpenAI `tools` and an optional `tool_choice`
(`auto`, `none`, `required`, or a named function). The Worker asks the backend
for a textual tool decision and converts it to a single `tool_calls` entry.
The client executes the function and sends back the assistant tool call and a
`tool` message with the matching `tool_call_id`. Function arguments must be a
JSON object. Validate them against your schema before execution.

Chat history is combined into one prompt. Both backends control generation
settings such as temperature. This interface accepts text and function
results. Structured outputs are unavailable. Token usage is reported only when
the authenticated GigaChat API returns it. Use `POST /query`
for Alice answers with structured source citations.
