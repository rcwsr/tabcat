// Decision providers share one interface so the backend can be swapped:
//   decide(state, questions) -> { answers, usage }
// using the Jev request and response shapes.

// Talks to a local layad daemon (https://github.com/rcwsr/layad), which keeps
// Laya resident and serves the Jev wire format on POST /ai/run.

export class LayaProvider {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async decide(state, questions) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}/ai/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, questions }),
      });
    } catch {
      throw new Error(`Can't reach layad at ${this.baseUrl}. Is it running? Try "layad status".`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // layad is FastAPI, which reports errors as { detail } (a string or a validation list).
      const detail = body.detail && (typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
      throw new Error(detail ? `layad: ${detail}` : `layad returned ${res.status}`);
    }
    return res.json();
  }
}

export class JevProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async decide(_state, _questions) {
    // TODO: call TypeSafe Jev (or OpenRouter Decisions) with the same payload.
    throw new Error("Jev provider not implemented yet");
  }
}

export function createProvider(settings) {
  switch (settings.provider) {
    case "jev":
      return new JevProvider(settings.jevApiKey);
    case "laya":
    default:
      return new LayaProvider(settings.layaUrl);
  }
}
