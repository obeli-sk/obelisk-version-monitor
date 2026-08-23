import { runSyncFlakeLockSubmit, runSyncFlakeLockAwaitNext } from "obeli-sk:version-monitor-obelisk-ext/github";

// obeli-sk:version-monitor/bump.run:
//   func(repos: list<string>) -> result<list<record { repo: string, result: string }>, string>
//
// Batch bump: fans out `run-sync-flake-lock` per selected repo via named join
// sets, then drains them in submission order. Writes nothing durable of its own;
// each dispatch's outcome shows up in the next monitor snapshot's gh-action
// column. The returned list is a per-repo summary for the execution log.
export default function run(repos) {
    const perRepo = [];
    for (const repo of repos) {
        const js = obelisk.createJoinSet({ name: sanitizeJoinSetName(repo) });
        runSyncFlakeLockSubmit(js, repo);
        perRepo.push({ repo, js });
    }

    const results = [];
    for (const { repo, js } of perRepo) {
        try {
            results.push({ repo, result: runSyncFlakeLockAwaitNext(js) });
        } catch (e) {
            results.push({ repo, result: `error: ${String(e)}` });
        }
    }
    return results;
}

// Join set names allow only alphanumeric, `-`, and `/`. Replace anything
// else with `-`.
function sanitizeJoinSetName(s) {
    return s.replace(/[^A-Za-z0-9\-\/]/g, "-");
}
