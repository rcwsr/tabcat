// storage.session: what Tabcat remembers until Firefox closes. It outlives the background
// page, which Firefox suspends when it's been idle for about 30 seconds.

export async function sessionGet(key, fallback) {
  return (await browser.storage.session.get({ [key]: fallback }))[key];
}

// Changes one value: change(value) returns the new one. Changes run one at a time, so two
// at once (ungrouping a whole group takes every tab out together) don't lose each other's.
let queue = Promise.resolve();

export function sessionUpdate(key, fallback, change) {
  const run = queue.then(async () => {
    const value = change(await sessionGet(key, fallback));
    await browser.storage.session.set({ [key]: value });
    return value;
  });
  queue = run.catch(() => {});
  return run;
}
