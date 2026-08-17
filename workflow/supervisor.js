// obeli-sk:version-monitor/supervisor.run: func() -> result<string, string>
//
// Booted once (`@once` cron) and runs for the lifetime of the deployment. Each
// cycle it lists the org's repos and starts one `repo-monitor.run` workflow for
// any repo that does not already have one, then self-publishes the
// repo -> execution-id directory on the `supervisor.directory` notification
// stub so the UI can locate each repo's workflow. The known map is rebuilt
// deterministically on replay, so no external bookkeeping is needed to avoid
// double-spawning.
import { listRepos } from "obeli-sk:version-monitor/repos";

const REPO_MONITOR_FFQN = "obeli-sk:version-monitor/repo-monitor.run";
const DIRECTORY_FFQN = "obeli-sk:version-monitor/supervisor.directory";
const RESCAN_MINUTES = 5;

export default function run() {
    const directory = obelisk.createJoinSet({ name: "directory" });
    const known = {}; // repo -> execution id of its repo-monitor workflow
    let seq = 0;

    while (true) {
        for (const repo of listRepos()) {
            if (!known[repo]) {
                const execId = obelisk.executionIdGenerate();
                obelisk.schedule(execId, REPO_MONITOR_FFQN, [repo]);
                known[repo] = execId;
            }
        }

        const eid = directory.submit(DIRECTORY_FFQN, [String(seq++)]);
        obelisk.stub(eid, { ok: JSON.stringify(known) });
        directory.joinNext();

        obelisk.sleep({ minutes: RESCAN_MINUTES });
    }
}
