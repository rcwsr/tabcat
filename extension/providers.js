// Decision providers share one interface so the backend can be swapped:
//   decide(state, questions) -> { answers, usage }
// using the Jev/Laya systemOne request and response shapes.

export class LayaProvider {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async decide(state, questions) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}/system-one`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, questions }),
      });
    } catch {
      throw new Error(`Can't reach the Taby helper at ${this.baseUrl}. Is it running?`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Helper returned ${res.status}`);
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
