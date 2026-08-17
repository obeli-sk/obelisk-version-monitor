// obeli-sk:version-monitor/repo-monitor.run: func(repo: string) -> result<string, string>
//
// One long-running workflow per repo. Each cycle it refreshes the repo's
// obelisk version and sync-flake-lock PR state, self-publishes that snapshot on
// the `repo-monitor.state` notification stub, then drains any actions delivered
// on the `repo-monitor.action` mailbox stub (run-gha / merge) before sleeping.
// Exactly one action offer is kept outstanding at all times. The workflow ends
// when the repo is archived or deleted.
//
// Minimal cut: actions are picked up on the next cycle (<= REFRESH_SECONDS)
// rather than interrupting the sleep. The UI injects an action by fulfilling
// the pending `repo-monitor.action` stub (PUT /v1/executions/<id>/stub) with an
// ok payload of `{"kind":"run-gha"}` or `{"kind":"merge","number":N,"head":"<sha>"}`.
import { fetchDevDeps, fetchPullRequests, checkActive } from "obeli-sk:version-monitor/repos";
import { runSyncFlakeLock, mergePullRequest } from "obeli-sk:version-monitor/github";

const STATE_FFQN = "obeli-sk:version-monitor/repo-monitor.state";
const ACTION_FFQN = "obeli-sk:version-monitor/repo-monitor.action";
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
        obelisk.stub(eid, { ok: JSON.stringify(snapshot) });
        state.joinNext();

        // Drain any actions delivered since the last cycle, re-arming the offer
        // after each so a single unambiguous target stays pending.
        let delivered = inbox.joinNextTry();
        while (delivered !== undefined) {
            handleAction(repo, delivered, snapshot.pull_request);
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

function handleAction(repo, payloadJson, pullRequest) {
    let action;
    try {
        action = JSON.parse(payloadJson);
    } catch (e) {
        console.warn("ignoring malformed action:", payloadJson);
        return;
    }
    try {
        if (action.kind === "run-gha") {
            runSyncFlakeLock(repo);
        } else if (action.kind === "merge") {
            mergePullRequest(repo, action.number, action.head);
        } else {
            console.warn("unknown action kind:", action.kind);
        }
    } catch (e) {
        console.warn("action failed:", action.kind, String(e));
    }
}
