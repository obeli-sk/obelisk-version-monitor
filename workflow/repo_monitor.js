// obeli-sk:version-monitor/repo-monitor.run: func(repo: string) -> result<string, string>
//
// One long-running workflow per repo. Each cycle it refreshes the repo's
// obelisk version and sync-flake-lock PR state, self-publishes that snapshot on
// the `repo-monitor-state.state` notification stub, then drains any actions
// delivered on the `repo-monitor-action.action` mailbox stub before sleeping.
// Exactly one action offer is kept outstanding at all times. The workflow ends
// when the repo is archived or deleted.
//
// Minimal cut: actions are picked up on the next cycle (<= REFRESH_SECONDS)
// rather than interrupting the sleep. The UI injects an action by fulfilling
// the pending `repo-monitor-action.action` stub (PUT /v1/executions/<id>/stub) with an
// ok payload of `"run_gha"` or `{"merge":{"number":N,"head":"<sha>"}}`.
import { fetchDevDeps, fetchPullRequests, checkActive } from "obeli-sk:version-monitor/repos";
import { runSyncFlakeLock, mergePullRequest } from "obeli-sk:version-monitor/github";

const STATE_FFQN = "obeli-sk:version-monitor/repo-monitor-state.state";
const ACTION_FFQN = "obeli-sk:version-monitor/repo-monitor-action.action";
const REFRESH_SECONDS = 60;

export default function run(repo) {
    const state = obelisk.createJoinSet({ name: "state" });
    const inbox = obelisk.createJoinSet({ name: "action" });
    inbox.submit(ACTION_FFQN, []); // one outstanding offer
    let seq = 0;

    while (true) {
        let active = true;
        try {
            active = checkActive(repo);
        } catch (e) {
            console.warn("check-active failed, assuming still active:", String(e));
        }
        if (!active) {
            return "archived";
        }

        const snapshot = {
            repo,
            version: readVersion(repo),
            pull_request: readPullRequest(repo),
        };
        const eid = state.submit(STATE_FFQN, [String(seq++)]);
        obelisk.stub(eid, { ok: snapshot });
        state.joinNext();

        // Drain any actions delivered since the last cycle, re-arming the offer
        // after each so a single unambiguous target stays pending.
        let delivered = inbox.joinNextTry();
        while (delivered !== undefined) {
            handleAction(repo, delivered);
            inbox.submit(ACTION_FFQN, []);
            delivered = inbox.joinNextTry();
        }

        obelisk.sleep({ seconds: REFRESH_SECONDS });
    }
}

function readVersion(repo) {
    let text;
    try {
        text = fetchDevDeps(repo);
    } catch (e) {
        return null;
    }
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("obelisk ")) {
            return trimmed.substring("obelisk ".length).trim();
        }
    }
    return null;
}

function readPullRequest(repo) {
    try {
        return JSON.parse(fetchPullRequests([repo]))[repo] ?? null;
    } catch (e) {
        return null;
    }
}

function handleAction(repo, action) {
    try {
        if (action === "run_gha") {
            runSyncFlakeLock(repo);
        } else if (action?.merge) {
            mergePullRequest(repo, action.merge.number, action.merge.head);
        } else {
            console.warn("unknown action:", JSON.stringify(action));
        }
    } catch (e) {
        console.warn("action failed:", JSON.stringify(action), String(e));
    }
}
