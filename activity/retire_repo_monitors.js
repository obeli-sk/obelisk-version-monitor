// obeli-sk:version-monitor/repos.retire-repo-monitors: func() -> result<u32, string>
// backcompat: c6b7580 deployments may still have live per-repo monitors and supervisors.
const MONITOR_FFQN_PREFIX = "obeli-sk:version-monitor/repo-monitor.run";
const LEGACY_SUPERVISOR_FFQN = "obeli-sk:version-monitor/supervisor.run";

export default async function retire_repo_monitors() {
    let retired = 0;
    for (const prefix of [MONITOR_FFQN_PREFIX, LEGACY_SUPERVISOR_FFQN]) {
        for (const execution of await listExecutions(prefix)) {
            if (execution.ffqn === LEGACY_SUPERVISOR_FFQN
                || execution.ffqn.startsWith(MONITOR_FFQN_PREFIX)) {
                retired += await retire(execution) ? 1 : 0;
            }
        }
    }
    return retired;
}

async function listExecutions(ffqnPrefix) {
    const query = `ffqn_prefix=${encodeURIComponent(ffqnPrefix)}&hide_finished=true&length=200`;
    const response = await fetchObelisk(`/v1/executions?${query}`);
    if (!response.ok) {
        throw `failed to list ${ffqnPrefix}: HTTP ${response.status}`;
    }
    const executions = await response.json();
    return Array.isArray(executions) ? executions : executions.executions || [];
}

async function retire(execution) {
    const action = execution.ffqn.endsWith("-cancellable") ? "cancel" : "pause";
    if (action === "pause" && execution.pending_state?.status === "paused") {
        return false;
    }
    const response = await fetchObelisk(
        `/v1/executions/${encodeURIComponent(execution.execution_id)}/${action}`,
        { method: "PUT" },
    );
    if (!response.ok && response.status !== 409) {
        throw `failed to ${action} ${execution.execution_id}: HTTP ${response.status}`;
    }
    return response.ok;
}

async function fetchObelisk(path, options = {}) {
    const apiBase = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const token = process.env["OBELISK__API__TOKEN"];
    if (!token) {
        throw "OBELISK__API__TOKEN secret is unavailable";
    }
    return await fetch(`${apiBase}${path}`, {
        ...options,
        headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
        },
    });
}
