// #345 — where a connected code repo's CI gets `YAD_PRODUCT_TOKEN`, the token `checks/product-checkout.sh`
// clones the Product with before the four Product-reading gates. Without it those gates only defer, so a
// token that is missing, or set where the PR pipelines never see it, goes quiet. `yad doctor` asks the
// platform, with the user's own `gh`/`glab` (the E70 reads in cli/protection.mjs, and the same
// `YAD_PLATFORM_READ=0` off switch), and reports:
//   - whether the code repo has the secret (GitHub: an Actions secret on the repo, or an organisation
//     secret shared with it; GitLab: a CI/CD variable on the project, or on one of its groups);
//   - on GitLab, a variable that MR pipelines never get: `protected` (only protected branches get it) or
//     limited to one environment;
//   - on GitLab, a token set on a GROUP — every project in that group then gets a token that reads the
//     Product (the user's decision, 2026-10-19: that is the "wrong level"), with the other registered
//     repos in that group named;
//   - on a GitLab Product, its own access tokens that can clone it and expire within 30 days. Which of them
//     is the one in a code repo's variable is never known here, and the line says so.
// NAMES ONLY. A token's value never reaches this machine from GitHub (its API lists secret names), but
// GitLab's variables API answers with each variable's value: the answer is cut down to key, `protected`
// and `environment_scope` at the call, and nothing else of it is kept or printed. The token's own expiry
// is read where the token is — in CI, by product-checkout.sh.
import { run } from './lib.mjs';
import { api, loggedIn, whyFailed, repoPathFromGitUrl, shown, PAGE, PLATFORM_NAME } from './protection.mjs';
import { cliFor, hostFromGitUrl, detectPlatform, plainHost } from './platform.mjs';

export const TOKEN_NAME = 'YAD_PRODUCT_TOKEN';
export const EXPIRY_WARN_DAYS = 30;

const enc = (p) => encodeURIComponent(p);

// The parts every platform read shares: which CLI, which host, which repo, and whether it may be asked.
function target({ platform, gitUrl }, { runner, env, authCache }) {
  const rawHost = hostFromGitUrl(gitUrl || '');
  const host = plainHost(rawHost);
  const repo = repoPathFromGitUrl(gitUrl || '');
  const plat = platform || detectPlatform(gitUrl || '') || null;
  const base = { platform: plat, host, repo };
  const unknown = (kind, why) => ({ ...base, known: false, kind, why });
  const cli = cliFor(plat);
  if (!cli) return { fail: unknown('no-platform', 'no platform yad reads (GitHub or GitLab) is set for it') };
  if (env.YAD_PLATFORM_READ === '0') return { fail: unknown('off', 'platform reads are turned off (YAD_PLATFORM_READ=0)') };
  if (rawHost && !host) return { fail: unknown('no-url', 'its git remote URL names a host that is not a plain host name, so yad does not ask about it') };
  if (!host || !repo) return { fail: unknown('no-url', 'no git remote URL yad can read, so it cannot tell which repo to ask about') };
  if (!runner(process.platform === 'win32' ? 'where' : 'which', [cli], {}).ok) return { fail: unknown('no-cli', `${cli} is not installed, so yad cannot ask ${PLATFORM_NAME[plat]}`) };
  if (!loggedIn(runner, cli, host, authCache)) return { fail: unknown('no-login', `${cli} is not logged in for ${host} (or ${host} did not answer)`) };
  return { base, cli, unknown };
}

// GitLab variables, cut down at the call to what may be kept: never the value.
const gitlabVars = (body) => (Array.isArray(body) ? body : [])
  .filter((v) => v && v.key === TOKEN_NAME)
  .map((v) => ({ protected: v.protected === true, scope: typeof v.environment_scope === 'string' ? v.environment_scope : '*' }));

// Where the code repo's CI gets the token. `{ known: false, why, kind }` when the repo's own list could not
// be read; otherwise `{ known: true, platform, project, org | groups }`, where each place is
//   GitHub  project: { set }            org: { set: true|false|null, why }
//   GitLab  project: { set, vars: [{ protected, scope }] }
//           groups: [{ path, set: true|false|null, vars, why }] — nearest group first
export function readTokenPlacement({ platform, gitUrl }, { runner = run, env = process.env, authCache = new Map() } = {}) {
  const t = target({ platform, gitUrl }, { runner, env, authCache });
  if (t.fail) return t.fail;
  const { base, unknown } = t;
  const { host, repo } = base;
  if (base.platform === 'github') {
    const what = `the Actions secrets of ${shown(repo)}`;
    const r = api(runner, 'gh', host, `repos/${repo}/actions/secrets?per_page=${PAGE}`);
    if (!r.ok || !Array.isArray(r.body?.secrets)) return unknown('other', r.ok ? `GitHub answered ${what} with something yad could not read` : whyFailed(r, { platform: 'github', host, what, plural: true }));
    const set = r.body.secrets.some((s) => s?.name === TOKEN_NAME);
    // A full page that does not hold the name proves nothing about the next one.
    if (!set && r.body.secrets.length >= PAGE) return unknown('partial', `${shown(repo)} has more than ${PAGE} Actions secrets, and yad reads one page`);
    if (set) return { ...base, known: true, project: { set: true } };
    const o = api(runner, 'gh', host, `repos/${repo}/actions/organization-secrets?per_page=${PAGE}`);
    const orgRead = o.ok && Array.isArray(o.body?.secrets);
    const orgSet = orgRead ? o.body.secrets.some((s) => s?.name === TOKEN_NAME) : null;
    const orgWhy = orgRead ? (!orgSet && o.body.secrets.length >= PAGE ? `it shares more than ${PAGE}, and yad reads one page` : null)
      : (o.ok ? 'GitHub answered with something yad could not read' : whyFailed(o, { platform: 'github', host, what: 'the organisation secrets shared with it', plural: true }));
    return { ...base, known: true, project: { set: false }, org: { set: orgWhy ? null : orgSet, why: orgWhy } };
  }
  const what = `the CI/CD variables of ${shown(repo)}`;
  const r = api(runner, 'glab', host, `projects/${enc(repo)}/variables?per_page=${PAGE}`);
  if (!r.ok || !Array.isArray(r.body)) return unknown('other', r.ok ? `GitLab answered ${what} with something yad could not read` : whyFailed(r, { platform: 'gitlab', host, what, plural: true }));
  const vars = gitlabVars(r.body);
  if (!vars.length && r.body.length >= PAGE) return unknown('partial', `${shown(repo)} has more than ${PAGE} CI/CD variables, and yad reads one page`);
  // Its groups, nearest first: `a/b/c` is in `a/b`, which is in `a`. A group's variable reaches every
  // project under it. Reading a group's variables needs a maintainer or owner there.
  const parts = repo.split('/');
  const groups = [];
  // A project in a user's own namespace (`someone/app`) has no groups. The project's own answer says whose
  // namespace it is, and anyone who can read its variables can read it — `namespaces/<user>` answers 404
  // to all but that user and an admin (review 2).
  const proj = api(runner, 'glab', host, `projects/${enc(repo)}`);
  const userNs = proj.ok && proj.body?.namespace?.kind === 'user';
  for (let i = userNs ? 0 : parts.length - 1; i >= 1; i--) {
    const g = parts.slice(0, i).join('/');
    const gr = api(runner, 'glab', host, `groups/${enc(g)}/variables?per_page=${PAGE}`);
    if (!gr.ok || !Array.isArray(gr.body)) {
      groups.push({ path: g, set: null, vars: [], why: gr.ok ? 'GitLab answered with something yad could not read' : whyFailed(gr, { platform: 'gitlab', host, what: `the CI/CD variables of the group ${shown(g)}`, plural: true }) });
      continue;
    }
    const gv = gitlabVars(gr.body);
    const full = !gv.length && gr.body.length >= PAGE;
    groups.push({ path: g, set: full ? null : gv.length > 0, vars: gv, why: full ? `it has more than ${PAGE} CI/CD variables, and yad reads one page` : null });
  }
  return { ...base, known: true, project: { set: vars.length > 0, vars }, groups };
}

// What a set of GitLab variables misses: MR pipelines on unprotected branches never get a protected one,
// and get an environment-scoped one only in a job that names that environment (the gate jobs name none).
function reachProblem(vars) {
  if (!vars.length) return null;
  if (vars.some((v) => !v.protected && v.scope === '*')) return null;
  if (vars.every((v) => v.protected)) return 'it is a PROTECTED variable, which only pipelines on protected branches get — so no merge request from a feature branch does';
  return `it is limited to the environment ${vars.filter((v) => v.scope !== '*').map((v) => shown(v.scope)).join(', ')}, which the gate jobs do not name — so they never get it`;
}
const UNPROTECT = 'Settings → CI/CD → Variables: edit it, untick "Protect variable", keep "Mask variable", and set the environment to All (*)';

// One doctor line for one code repo: { status, message, hint }. `others(groupPath)` names the other
// registered repos in that group.
export function tokenLine(r, { name, others = () => [] } = {}) {
  const who = name;
  // A warn, as E70's "not known" is: doctor prints ok, warn and fail only (review 1).
  if (!r.known) return { status: 'warn', message: `${who}: whether ${TOKEN_NAME} is set for its CI is not known — ${r.why}` };
  const defer = 'contract-check, lineage-check, epic-open and reconcile-debt-check cannot read the Product there and only defer';
  if (r.platform === 'github') {
    if (r.project.set) return { status: 'ok', message: `${who}: ${TOKEN_NAME} is set as an Actions secret` };
    if (r.org.set === true) return { status: 'ok', message: `${who}: ${TOKEN_NAME} comes from an organisation secret shared with it` };
    const add = `add a token that can read the Product: gh secret set ${TOKEN_NAME} --repo ${shown(r.repo)}`;
    if (r.org.set === null) return { status: 'warn', message: `${who}: ${TOKEN_NAME} is not an Actions secret of the repo, and the organisation secrets shared with it could not be read (${r.org.why}) — unless it is one of those, ${defer} on every PR`, hint: add };
    return { status: 'warn', message: `${who}: ${TOKEN_NAME} is not set for its CI — ${defer} on every PR`, hint: add };
  }
  const groupSet = r.groups.filter((g) => g.set === true);
  const unread = r.groups.filter((g) => g.set === null);
  const groupNote = (g) => {
    const also = others(g.path);
    return `the group ${shown(g.path)} also sets ${TOKEN_NAME}, so every project in it gets a token that can read the Product${also.length ? ` (registered here: ${also.join(', ')})` : ''}`;
  };
  if (r.project.set) {
    const miss = reachProblem(r.project.vars);
    if (miss) return { status: 'warn', message: `${who}: ${TOKEN_NAME} is set on the project, but ${miss} and ${defer} on them`, hint: UNPROTECT };
    if (groupSet.length) return { status: 'warn', message: `${who}: ${TOKEN_NAME} is set on the project, and ${groupNote(groupSet[0])}`, hint: `remove it from the group's CI/CD variables (Settings → CI/CD → Variables of ${shown(groupSet[0].path)}) unless every project there should read the Product` };
    return { status: 'ok', message: `${who}: ${TOKEN_NAME} is set on the project` };
  }
  if (groupSet.length) {
    const g = groupSet[0];
    const miss = reachProblem(g.vars);
    const also = others(g.path);
    return {
      status: 'warn',
      message: `${who}: ${TOKEN_NAME} comes from the group ${shown(g.path)}, so every project in that group gets a token that can read the Product${also.length ? ` (registered here: ${also.join(', ')})` : ''}${miss ? `; and ${miss}` : ''}`,
      hint: `set it on the project instead (Settings → CI/CD → Variables: masked, not protected, all environments), then remove it from the group ${shown(g.path)}`,
    };
  }
  const add = `add a token that can read the Product as the ${TOKEN_NAME} CI/CD variable of ${shown(r.repo)} (Settings → CI/CD → Variables: masked, not protected, all environments)`;
  if (unread.length) {
    return { status: 'warn', message: `${who}: ${TOKEN_NAME} is not set on the project, and ${unread.length === 1 ? `the group ${shown(unread[0].path)} could` : `the groups ${unread.map((g) => shown(g.path)).join(', ')} could`} not be read (${unread[0].why}) — unless it is set there, ${defer} on every merge request`, hint: add };
  }
  return { status: 'warn', message: `${who}: ${TOKEN_NAME} is not set on the project or its groups — ${defer} on every merge request`, hint: add };
}

// A GitLab Product's own access tokens that can clone it and expire within EXPIRY_WARN_DAYS, or expired
// within the last EXPIRY_WARN_DAYS. `today` is
// YYYY-MM-DD (injectable for tests). `{ known: false, why }`, or `{ known: true, soon: [{ name, expires,
// days, scopes }] }`.
export function readExpiringProductTokens({ gitUrl }, { runner = run, env = process.env, authCache = new Map(), today = new Date().toISOString().slice(0, 10) } = {}) {
  const t = target({ platform: 'gitlab', gitUrl }, { runner, env, authCache });
  if (t.fail) return t.fail;
  const { base, unknown } = t;
  const what = `the access tokens of ${shown(base.repo)}`;
  const r = api(runner, 'glab', base.host, `projects/${enc(base.repo)}/access_tokens?per_page=${PAGE}`);
  if (!r.ok || !Array.isArray(r.body)) return unknown('other', r.ok ? `GitLab answered ${what} with something yad could not read` : whyFailed(r, { platform: 'gitlab', host: base.host, what, plural: true }));
  const day = (d) => Date.parse(`${d}T00:00:00Z`) / 864e5;
  const soon = [];
  for (const tok of r.body) {
    // An EXPIRED token is listed with `active: false`: kept, so doctor says it expired (review 1). Only a
    // revoked one is gone on purpose.
    if (!tok || tok.revoked === true) continue;
    const scopes = Array.isArray(tok.scopes) ? tok.scopes.filter((s) => typeof s === 'string') : [];
    if (!scopes.some((s) => s === 'read_repository' || s === 'api')) continue;
    const exp = typeof tok.expires_at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(tok.expires_at) ? tok.expires_at.slice(0, 10) : null;
    if (!exp) continue;
    const days = Math.round(day(exp) - day(today));
    // Within 30 days either side: one that expired long ago is no news, and GitLab offers no way to remove
    // an expired token from its list, so a line about it could never be cleared (review 3).
    if (days <= EXPIRY_WARN_DAYS && days >= -EXPIRY_WARN_DAYS) soon.push({ id: Number.isInteger(tok.id) ? tok.id : null, name: typeof tok.name === 'string' ? tok.name : `#${tok.id}`, expires: exp, days, scopes });
  }
  // A full page proves nothing about the tokens past it (review 1).
  if (r.body.length >= PAGE) return unknown('partial', `${shown(base.repo)} has more than ${PAGE} access tokens, and yad reads one page`);
  return { ...base, known: true, soon };
}
