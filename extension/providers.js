// Decision providers share one interface so the backend can be swapped:
//   decide(state, questions) -> { answers, usage }
// using the Jev request and response shapes.

import { chooseBySimilarity, choiceText } from "./cluster.js";
import { embedWithFirefox } from "./firefox-ml.js";
import { embed } from "./ml.js";

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

// Answers choice questions on the device: the option whose description is most similar to
// the tab (by sentence embeddings) wins. On 48 labelled tabs with the default categories it
// got 37 right to Laya's 36, but its confidence is rougher: at 0.5 it placed 43 tabs, 34
// correctly, where Laya placed 31, 28 correctly.
const TEMPERATURE = 0.03;

export class EmbeddingProvider {
  constructor(embedFn) {
    this.embed = embedFn;
    this.vectors = new Map(); // option description -> vector
  }

  async #vectorsFor(texts) {
    const missing = texts.filter((t) => !this.vectors.has(t));
    if (missing.length) (await this.embed(missing)).forEach((v, i) => this.vectors.set(missing[i], v));
    return texts.map((t) => this.vectors.get(t));
  }

  async decide(state, questions) {
    const [vector] = await this.embed([choiceText(state)]);
    const answers = {};
    for (const [name, { type, criteria }] of Object.entries(questions)) {
      if (type !== "choice") throw new Error(`The on-device model can't answer "${type}" questions.`);
      const vectors = await this.#vectorsFor(Object.values(criteria));
      const options = Object.fromEntries(Object.keys(criteria).map((k, i) => [k, vectors[i]]));
      answers[name] = chooseBySimilarity(vector, options, TEMPERATURE);
    }
    return { answers };
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
      return new LayaProvider(settings.layaUrl);
    case "firefox":
      return new EmbeddingProvider(embedWithFirefox);
    case "tav":
    default:
      return new EmbeddingProvider(embed);
  }
}
