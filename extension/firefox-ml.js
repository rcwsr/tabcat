// Firefox's built-in on-device AI (browser.trial.ml). It's experimental: Tav needs the
// optional trialML permission, and the user has to set browser.ml.enable and
// extensions.ml.enabled in about:config. Firefox allows one engine per extension, which
// is all categories mode needs.

export const FIREFOX_ML_PERMISSION = { permissions: ["trialML"] };

let ready;

function engine() {
  ready ??= (async () => {
    if (!browser.trial?.ml) {
      throw new Error("Tav needs permission to use Firefox's built-in AI. Right-click the Tav button → Settings to allow it.");
    }
    try {
      await browser.trial.ml.createEngine({
        modelHub: "huggingface",
        taskName: "feature-extraction",
        modelId: "Xenova/all-MiniLM-L6-v2",
        // The same quantised weights as Tav's bundled copy (also Firefox's default today).
        dtype: "q8",
      });
    } catch (err) {
      if (/disabled/i.test(err.message)) {
        throw new Error(
          "Firefox's built-in AI is turned off. In about:config, set browser.ml.enable and extensions.ml.enabled to true.",
        );
      }
      // The engine outlives this background page, so after a restart it already exists.
      if (!/already created/i.test(err.message)) throw err;
    }
  })().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

// One unit vector per text, from the same model Tav bundles.
export async function embedWithFirefox(texts) {
  await engine();
  return browser.trial.ml.runEngine({ args: [texts], options: { pooling: "mean", normalize: true } });
}
