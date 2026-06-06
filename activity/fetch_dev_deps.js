// obeli-sk:version-monitor/repos.fetch-dev-deps:
//   func(repo: string) -> result<string, variant {
//       permanent-not-found,
//       transient-error(string),
//       execution-failed,
//   }>
//
// Fetches `dev-deps.txt` from the default branch of `obeli-sk/<repo>` via
// raw.githubusercontent.com. The variant err arm distinguishes:
//   - permanent-not-found      → file does not exist on either main or master.
//                                Contains "permanent" in its name, so obelisk
//                                won't retry.
//   - transient-error(string)  → network/5xx/etc., obelisk will retry. The
//                                payload carries a diagnostic message.
//   - execution-failed         → reserved by obelisk for trap/timeout escalation.
//
// Throwing a snake_case string selects a no-payload variant case; throwing
// `{ case_name: payload }` selects a case with payload.
export default async function fetch_dev_deps(repo) {
    // Try `main` first, then fall back to `master`.
    const branches = ["main", "master"];
    for (const branch of branches) {
        const url = `https://raw.githubusercontent.com/obeli-sk/${repo}/${branch}/dev-deps.txt?cache-bust=${Date.now()}`;
        console.info("Fetching", url);
        const resp = await fetch(url, {
            headers: {
                "cache-control": "no-cache",
                "user-agent": "obelisk-version-monitor",
            },
        });
        if (resp.ok) {
            return await resp.text();
        }
        if (resp.status !== 404) {
            const msg = `HTTP ${resp.status} fetching ${url}`;
            console.warn(msg);
            throw { transient_error: msg };
        }
    }
    console.info("dev-deps.txt not found for", repo);
    throw "permanent_not_found";
}
