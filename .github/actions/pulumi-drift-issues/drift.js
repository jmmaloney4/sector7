// Pulumi drift issues: one GitHub issue per drifted (project, stack).
//
// record() runs in each stack's matrix job and writes that stack's result as a
// JSON file. reconcile() runs once after the matrix and brings the repo's
// `pulumi-drift` issues in line with the results:
//
//   drift, unknown or preview-failed  -> open an issue (or update the open one)
//   clean                             -> record it; close the issue once every
//                                        mode that reported a problem is clean
//   deployed                          -> ignored (the run applied the stack)
//
// The issue body carries its own state in a marker comment, so reconcile needs
// no other storage. Modes are tracked separately: a clean `code` run proves
// nothing about drift that only a `live` (refreshed) run can see, so it cannot
// close an issue opened by `live`. Comments are posted only when a mode's status
// changes, so a stack that stays drifted under a daily schedule does not spam.
//
// Only results from the repository's default branch count: a preview of a
// branch says nothing about what is deployed.
//
// Runs under actions/github-script (CommonJS, Node built into the runner), so
// callers need no gh, jq or python on the runner.

"use strict";

const fs = require("fs");
const path = require("path");

const MARKER = "sector7-pulumi-drift";
const LABEL = "pulumi-drift";
const PROBLEM = new Set(["drift", "unknown", "preview-failed"]);
const STATUSES = new Set([...PROBLEM, "clean", "deployed"]);
const MODES = new Set(["code", "live"]);
const MAX_CHANGES = 25;

function resultStatus({ previewOutcome, driftStatus, deployed }) {
  if (deployed) return "deployed";
  if (previewOutcome !== "success") return "preview-failed";
  return driftStatus === "clean" || driftStatus === "drift"
    ? driftStatus
    : "unknown";
}

// The resources a `pulumi preview --json` file would change, or null if unreadable.
function previewChanges(file) {
  let steps;
  try {
    steps = JSON.parse(fs.readFileSync(file, "utf8")).steps;
  } catch {
    return null;
  }
  if (!Array.isArray(steps)) return null;
  return steps
    .filter((s) => s && !["same", "read", "refresh"].includes(s.op))
    .map((s) => {
      const parts = String(s.urn || "").split("::");
      return {
        op: String(s.op),
        type: parts[parts.length - 2] || "?",
        name: parts[parts.length - 1] || "?",
      };
    });
}

function record(env) {
  const mode = env.DRIFT_MODE;
  if (!MODES.has(mode)) {
    throw new Error(`drift issues need drift_mode code or live, got "${mode}"`);
  }
  const status = resultStatus({
    previewOutcome: env.PREVIEW_OUTCOME,
    driftStatus: env.DRIFT_STATUS,
    deployed: env.UP_STAGE === "success" || env.UP_PROD === "success",
  });
  const changes =
    status === "drift" ? previewChanges(env.PREVIEW_JSON) || [] : [];
  const result = {
    project: env.PROJECT,
    stack: env.STACK,
    mode,
    status,
    changeCount: env.CHANGE_COUNT === "" ? null : Number(env.CHANGE_COUNT),
    changes: changes.slice(0, MAX_CHANGES),
    moreChanges: Math.max(0, changes.length - MAX_CHANGES),
    ref: env.REF,
    runUrl: env.RUN_URL,
  };
  fs.mkdirSync(env.OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(env.OUT_DIR, `${env.SAFE_NAME}__${env.STACK}.json`),
    JSON.stringify(result, null, 2),
  );
  return result;
}

function readResults(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) out.push(JSON.parse(fs.readFileSync(p, "utf8")));
    }
  };
  walk(dir);
  for (const r of out) {
    if (!r.project || !r.stack || !MODES.has(r.mode) || !STATUSES.has(r.status)) {
      throw new Error(`malformed drift result: ${JSON.stringify(r)}`);
    }
  }
  return out;
}

const key = (project, stack) => `${project}\u0000${stack}`;

function parseState(body) {
  const m = String(body || "").match(
    new RegExp(`<!-- ${MARKER} (\\{.*?\\}) -->`),
  );
  if (!m) return null;
  try {
    const s = JSON.parse(m[1]);
    return s && s.project && s.stack && s.modes ? s : null;
  } catch {
    return null;
  }
}

const STATUS_TEXT = {
  clean: "in sync",
  drift: "**drift**",
  unknown: "**unknown** (the preview's change count could not be read)",
  "preview-failed": "**preview failed**",
};

function renderBody(state, latest) {
  const rows = Object.entries(state.modes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([mode, m]) =>
        `| \`${mode}\` | ${STATUS_TEXT[m.status] || m.status} | ${m.changeCount ?? ""} | [run](${m.runUrl}) |`,
    );
  const lines = [
    `Pulumi stack \`${state.project}\` (\`${state.stack}\`) is out of sync with its code on the default branch.`,
    "",
    "| mode | status | changes | last run |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "`code` compares the code with Pulumi state. `live` also refreshes from the real infrastructure, so it catches changes made outside Pulumi.",
  ];
  if (latest.status === "drift" && latest.changes.length > 0) {
    lines.push("", `Latest \`${latest.mode}\` preview would change:`, "");
    for (const c of latest.changes) {
      lines.push(`- \`${c.op}\` ${c.type} \`${c.name}\``);
    }
    if (latest.moreChanges > 0) lines.push(`- …and ${latest.moreChanges} more`);
  }
  lines.push(
    "",
    "To resolve: apply the stack, or change the code to match what is deployed. This issue closes itself when the next run in each mode above is clean.",
    "",
    `<!-- ${MARKER} ${JSON.stringify(state)} -->`,
  );
  return lines.join("\n");
}

async function reconcile({ github, context, core, dir }) {
  const results = readResults(dir).filter((r) => r.status !== "deployed");
  const { owner, repo } = context.repo;
  const { data: repoInfo } = await github.rest.repos.get({ owner, repo });
  const defaultRef = `refs/heads/${repoInfo.default_branch}`;
  const counted = results.filter((r) => r.ref === defaultRef);
  if (counted.length < results.length) {
    core.notice(
      `drift issues: ignored ${results.length - counted.length} result(s) not from ${defaultRef}`,
    );
  }
  const summary = { opened: [], updated: [], closed: [], unchanged: [] };
  if (counted.length === 0) return summary;

  try {
    await github.rest.issues.getLabel({ owner, repo, name: LABEL });
  } catch (e) {
    if (e.status !== 404) throw e;
    await github.rest.issues.createLabel({
      owner,
      repo,
      name: LABEL,
      color: "d93f0b",
      description: "A Pulumi stack differs from its code (sector7 drift check)",
    });
  }

  const open = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    labels: LABEL,
    per_page: 100,
  });
  const byKey = new Map();
  for (const issue of open) {
    if (issue.pull_request) continue;
    const s = parseState(issue.body);
    if (s) byKey.set(key(s.project, s.stack), { issue, state: s });
  }

  for (const r of counted) {
    const k = key(r.project, r.stack);
    const existing = byKey.get(k);
    const entry = {
      status: r.status,
      changeCount: r.changeCount,
      runUrl: r.runUrl,
    };
    const label = `${r.project} (${r.stack})`;

    if (!existing) {
      if (!PROBLEM.has(r.status)) continue;
      const state = { project: r.project, stack: r.stack, modes: { [r.mode]: entry } };
      const { data } = await github.rest.issues.create({
        owner,
        repo,
        title: `Pulumi drift: ${label}`,
        body: renderBody(state, r),
        labels: [LABEL],
      });
      byKey.set(k, { issue: data, state });
      summary.opened.push(label);
      continue;
    }

    const { issue, state } = existing;
    const previous = state.modes[r.mode];
    if (!previous && r.status === "clean") {
      // A mode that never reported a problem has nothing to clear.
      summary.unchanged.push(label);
      continue;
    }
    state.modes[r.mode] = entry;
    const allClean = Object.values(state.modes).every((m) => m.status === "clean");
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: issue.number,
      body: renderBody(state, r),
      ...(allClean ? { state: "closed", state_reason: "completed" } : {}),
    });
    if (allClean) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: `In sync: the \`${r.mode}\` check is clean in [this run](${r.runUrl}), and no mode reports drift. Closing.`,
      });
      byKey.delete(k);
      summary.closed.push(label);
    } else if (!previous || previous.status !== r.status) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: `\`${r.mode}\` is now ${STATUS_TEXT[r.status] || r.status} ([run](${r.runUrl})).`,
      });
      summary.updated.push(label);
    } else {
      summary.unchanged.push(label);
    }
  }
  core.info(`drift issues: ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { record, reconcile, parseState, renderBody, resultStatus, previewChanges, LABEL, MARKER };
