// obeli-sk:version-monitor/repos.list-repos: func() -> result<list<string>, string>
//
// Fetches all public repositories of the `obeli-sk` GitHub organization and
// returns a list of repository names. Throws on HTTP error which is converted
// to the err arm of the result type.
export default async function list_repos() {
    const headers = {
        "accept": "application/vnd.github+json",
        "user-agent": "obelisk-version-monitor",
        "x-github-api-version": "2022-11-28",
    };

    const repos = [];
    let page = 1;
    while (true) {
        const url = `https://api.github.com/orgs/obeli-sk/repos?per_page=100&type=public&page=${page}`;
        console.info("Fetching", url);
        const resp = await fetch(url, { headers });
        if (!resp.ok) {
            throw `GitHub API ${resp.status}: ${await resp.text()}`;
        }
        const batch = await resp.json();
        if (!Array.isArray(batch) || batch.length === 0) {
            break;
        }
        for (const r of batch) {
            repos.push(r.name);
        }
        if (batch.length < 100) {
            break;
        }
        page += 1;
    }
    console.info("Found", repos.length, "repos");
    return repos;
}
