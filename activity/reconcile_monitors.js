// obeli-sk:version-monitor/repos.reconcile-monitors:
//   func(current-execution-id: string) -> result<string, string>
//
// Returns the repo -> execution-id map for live monitors from this deployment.
// Monitors from older deployments are cancelled when possible or paused for
// legacy non-cancellable FFQNs. Legacy long-running supervisors are paused.
const MONITOR_FFQN_PREFIX = "obeli-sk:version-monitor/repo-monitor.run";
const MONITOR_FFQN = `${MONITOR_FFQN_PREFIX}-cancellable`;
const LEGACY_SUPERVISOR_FFQN = "obeli-sk:version-monitor/supervisor.run";

export default async function reconcile_monitors(currentExecutionId) {
    const currentDeployment = await readDeploymentId(currentExecutionId);
    await retireLegacySupervisors();

    const executions = await listExecutions(MONITOR_FFQN_PREFIX);
    const byRepo = Object.create(null);
    for (const execution of executions) {
        if (execution.deployment_id !== currentDeployment || execution.ffqn !== MONITOR_FFQN) {
            await retire(execution);
            continue;
        }

        const repo = await readRepo(execution.execution_id);
        if (repo === null) {
            await retire(execution);
        } else if (Object.hasOwn(byRepo, repo)) {
            await retire(execution);
        } else {
            byRepo[repo] = execution.execution_id;
        }
    }
    return JSON.stringify(byRepo);
}

async function retireLegacySupervisors() {
    for (const execution of await listExecutions(LEGACY_SUPERVISOR_FFQN)) {
        if (execution.ffqn === LEGACY_SUPERVISOR_FFQN) {
            await retire(execution);
        }
    }
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

async function readDeploymentId(executionId) {
    const created = await readCreatedEvent(executionId);
    if (typeof created.deployment_id !== "string") {
        throw `execution ${executionId} has no deployment id`;
    }
    return created.deployment_id;
}

async function readRepo(executionId) {
    const created = await readCreatedEvent(executionId);
    const repo = created.params?.[0];
    return typeof repo === "string" ? repo : null;
}

async function readCreatedEvent(executionId) {
    const path = `/v1/executions/${encodeURIComponent(executionId)}/events?version=0&including_cursor=true&length=1`;
    const response = await fetchObelisk(path);
    if (!response.ok) {
        throw `failed to read execution ${executionId}: HTTP ${response.status}`;
    }
    const payload = await response.json();
    const created = payload.events?.[0]?.event?.created;
    if (!created) {
        throw `execution ${executionId} has no created event`;
    }
    return created;
}

async function retire(execution) {
    const action = execution.ffqn.endsWith("-cancellable") ? "cancel" : "pause";
    if (action === "pause" && execution.pending_state?.status === "paused") {
        return;
    }
    const response = await fetchObelisk(
        `/v1/executions/${encodeURIComponent(execution.execution_id)}/${action}`,
        { method: "PUT" },
    );
    if (!response.ok && response.status !== 409) {
        throw `failed to ${action} ${execution.execution_id}: HTTP ${response.status}`;
    }
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
