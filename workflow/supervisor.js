// obeli-sk:version-monitor/supervisor.reconcile: func() -> result<string, string>
//
// Finite reconciliation run. It retires monitors from older deployments, keeps
// one current monitor per repo, and starts monitors for newly discovered repos.
import { listRepos, reconcileMonitors } from "obeli-sk:version-monitor/repos";

const REPO_MONITOR_FFQN = "obeli-sk:version-monitor/repo-monitor.run-cancellable";

export default function run() {
    const known = JSON.parse(reconcileMonitors(obelisk.executionIdCurrent()));
    let started = 0;
    for (const repo of listRepos()) {
        if (!Object.hasOwn(known, repo)) {
            const execId = obelisk.executionIdGenerate();
            obelisk.schedule(execId, REPO_MONITOR_FFQN, [repo]);
            started += 1;
        }
    }
    return `reconciled ${Object.keys(known).length} monitors; started ${started}`;
}
