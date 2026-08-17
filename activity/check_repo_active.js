// obeli-sk:version-monitor/repos.check-active: func(repo: string) -> result<bool, string>
//
// Returns false when obeli-sk/<repo> is deleted (404) or archived, true when it
// is a live repo. Used by the per-repo monitor workflow to decide when to end.
// A non-404 HTTP error throws so Obelisk retries rather than treating a blip as
// deletion.
export default async function check_active(repo) {
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) {
        throw "invalid repository name";
    }
    const headers = {
        "accept": "application/vnd.github+json",
        "user-agent": "obelisk-version-monitor",
        "x-github-api-version": "2022-11-28",
    };
    const token = process.env["GH_TOKEN"];
    if (token) {
        headers.authorization = `Bearer ${token}`;
    }

    const resp = await fetch(`https://api.github.com/repos/obeli-sk/${encodeURIComponent(repo)}`, { headers });
    if (resp.status === 404) {
        return false;
    }
    if (!resp.ok) {
        throw `HTTP ${resp.status} looking up obeli-sk/${repo}`;
    }
    return (await resp.json()).archived !== true;
}
