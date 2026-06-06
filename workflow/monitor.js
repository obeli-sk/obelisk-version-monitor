import { listRepos } from "obeli-sk:version-monitor/repos";
import { fetchDevDepsSubmit, fetchDevDepsAwaitNext } from "obeli-sk:version-monitor-obelisk-ext/repos";

// obeli-sk:version-monitor/monitor.run:
//   func() -> result<list<tuple<string, string>>, string>
//
// Periodic workflow that:
//  - Lists all public repositories of the `obeli-sk` GitHub org.
//  - In parallel, fetches `dev-deps.txt` from each repo.
//  - Parses the line `obelisk <version>` from each file.
//  - Returns a list of `[repo, version]` pairs, skipping repos that
//      don't have the file or the line.
export default function run() {

    // List repos.
    const repos = listRepos();
    console.info("Got", repos.length, "repos");

    // Submit one fetch per repo. Each fetch lives in its own *named* join
    // set, with the join set name derived from the repo name. This makes
    // the workflow's event log self-describing — the WebUI shows
    // "join-set: my-repo" instead of an opaque generated id.
    // Join set names are restricted to alphanumeric + `-` + `/`, so we
    // sanitize anything else (`.`, `_`, etc.) to `-`.
    const perRepo = [];
    for (const repo of repos) {
        const js = obelisk.createJoinSet({ name: sanitizeJoinSetName(repo) });
        fetchDevDepsSubmit(js, repo);
        perRepo.push({ repo, js });
    }

    // Drain each join set in submission order, parsing the obelisk version
    // line from each successful response.
    const versions = [];
    for (const { repo, js } of perRepo) {
        let result;
        try {
            result = fetchDevDepsAwaitNext(js);
        } catch (e) {
            console.warn("dev-deps fetch failed for", repo);
            continue;
        }
        const version = parseObeliskVersion(result);
        if (version !== null) {
            versions.push([repo, version]);
        }
    }

    // Sort for stable output.
    versions.sort((a, b) => a[0].localeCompare(b[0]));
    return versions;
}

// Join set names allow only alphanumeric, `-`, and `/`. Replace anything
// else with `-`.
function sanitizeJoinSetName(s) {
    return s.replace(/[^A-Za-z0-9\-\/]/g, "-");
}

// Extract the version from a line like `obelisk 0.37.0` in `dev-deps.txt`.
// Returns null if the line is missing.
function parseObeliskVersion(text) {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("obelisk ")) {
            return trimmed.substring("obelisk ".length).trim();
        }
    }
    return null;
}
