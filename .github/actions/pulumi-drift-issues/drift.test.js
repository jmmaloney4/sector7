// node --test: record() and reconcile() against an in-memory GitHub fake.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const drift = require("./drift.js");

const RUN = "https://github.com/o/r/actions/runs/1";

function fakeGithub({ defaultBranch = "main" } = {}) {
  const issues = [];
  const comments = [];
  const labels = new Set();
  let next = 1;
  const rest = {
    repos: { get: async () => ({ data: { default_branch: defaultBranch } }) },
    issues: {
      getLabel: async ({ name }) => {
        if (!labels.has(name)) {
          const e = new Error("Not Found");
          e.status = 404;
          throw e;
        }
        return { data: { name } };
      },
      createLabel: async ({ name }) => labels.add(name),
      listForRepo: async () => ({}),
      create: async ({ title, body, labels: ls }) => {
        const issue = { number: next++, title, body, labels: ls, state: "open" };
        issues.push(issue);
        return { data: issue };
      },
      update: async ({ issue_number, body, state }) => {
        const i = issues.find((x) => x.number === issue_number);
        if (body !== undefined) i.body = body;
        if (state) i.state = state;
      },
      createComment: async ({ issue_number, body }) =>
        comments.push({ issue_number, body }),
    },
  };
  const github = {
    rest,
    paginate: async (fn, { state, labels: l }) =>
      issues.filter((i) => i.state === state && i.labels.includes(l)),
  };
  return { github, issues, comments, labels };
}

const context = { repo: { owner: "o", repo: "r" } };
const core = { info() {}, notice() {} };

function writeResults(results) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-"));
  results.forEach((r, i) =>
    fs.writeFileSync(path.join(dir, `${i}.json`), JSON.stringify(r)),
  );
  return dir;
}

const res = (over) => ({
  project: "deploy/app",
  stack: "prod",
  mode: "live",
  status: "drift",
  changeCount: 2,
  changes: [{ op: "update", type: "kubernetes:apps/v1:Deployment", name: "web" }],
  moreChanges: 0,
  ref: "refs/heads/main",
  runUrl: RUN,
  ...over,
});

const run = (gh, results) =>
  drift.reconcile({ github: gh.github, context, core, dir: writeResults(results) });

test("resultStatus maps step outcomes, never to clean by default", () => {
  assert.equal(drift.resultStatus({ previewOutcome: "success", driftStatus: "clean" }), "clean");
  assert.equal(drift.resultStatus({ previewOutcome: "success", driftStatus: "drift" }), "drift");
  assert.equal(drift.resultStatus({ previewOutcome: "success", driftStatus: "" }), "unknown");
  assert.equal(drift.resultStatus({ previewOutcome: "failure", driftStatus: "clean" }), "preview-failed");
  assert.equal(drift.resultStatus({ previewOutcome: "success", driftStatus: "drift", deployed: true }), "deployed");
});

test("record writes the result with the preview's changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
  const json = path.join(dir, "p.json");
  fs.writeFileSync(json, JSON.stringify({ steps: [
    { op: "same", urn: "urn:pulumi:prod::app::t::a" },
    { op: "update", urn: "urn:pulumi:prod::app::kubernetes:core/v1:ConfigMap::cm" },
  ] }));
  const r = drift.record({
    DRIFT_MODE: "code", PREVIEW_OUTCOME: "success", DRIFT_STATUS: "drift", CHANGE_COUNT: "1",
    PREVIEW_JSON: json, PROJECT: "deploy/app", STACK: "prod", SAFE_NAME: "deploy__app",
    REF: "refs/heads/main", RUN_URL: RUN, OUT_DIR: path.join(dir, "out"),
  });
  assert.deepEqual(r.changes, [{ op: "update", type: "kubernetes:core/v1:ConfigMap", name: "cm" }]);
  assert.ok(fs.existsSync(path.join(dir, "out", "deploy__app__prod.json")));
  assert.throws(() => drift.record({ DRIFT_MODE: "off" }), /code or live/);
});

test("drift opens one labelled issue; a repeat is quiet; clean closes it", async () => {
  const gh = fakeGithub();
  let s = await run(gh, [res({}), res({ project: "deploy/ok", status: "clean" })]);
  assert.deepEqual(s.opened, ["deploy/app (prod)"]);
  assert.equal(gh.issues.length, 1, "a clean stack opens nothing");
  assert.ok(gh.labels.has("pulumi-drift"));
  assert.match(gh.issues[0].body, /`update` kubernetes:apps\/v1:Deployment `web`/);

  s = await run(gh, [res({})]);
  assert.deepEqual(s.unchanged, ["deploy/app (prod)"]);
  assert.equal(gh.comments.length, 0, "unchanged drift posts no comment");
  assert.equal(gh.issues.length, 1, "no duplicate issue");

  s = await run(gh, [res({ status: "clean", changeCount: 0 })]);
  assert.deepEqual(s.closed, ["deploy/app (prod)"]);
  assert.equal(gh.issues[0].state, "closed");
});

test("a clean code run cannot close drift that only live saw", async () => {
  const gh = fakeGithub();
  await run(gh, [res({ mode: "live" })]);
  const s = await run(gh, [res({ mode: "code", status: "clean", changeCount: 0 })]);
  assert.deepEqual(s.unchanged, ["deploy/app (prod)"]);
  assert.equal(gh.issues[0].state, "open");
});

test("both modes drifting need both clean to close", async () => {
  const gh = fakeGithub();
  await run(gh, [res({ mode: "code" })]);
  await run(gh, [res({ mode: "live" })]);
  assert.equal(gh.comments.length, 1, "live joining is a status change");
  await run(gh, [res({ mode: "code", status: "clean" })]);
  assert.equal(gh.issues[0].state, "open");
  await run(gh, [res({ mode: "live", status: "clean" })]);
  assert.equal(gh.issues[0].state, "closed");
});

test("status changes comment; preview failure is a problem, deployed is ignored", async () => {
  const gh = fakeGithub();
  await run(gh, [res({ status: "preview-failed", changeCount: null })]);
  assert.equal(gh.issues.length, 1);
  await run(gh, [res({ status: "drift" })]);
  assert.equal(gh.comments.length, 1);
  const s = await run(gh, [res({ status: "deployed" })]);
  assert.deepEqual(s, { opened: [], updated: [], closed: [], unchanged: [] });
});

test("results from another branch are ignored (control: same result on main opens)", async () => {
  const gh = fakeGithub();
  await run(gh, [res({ ref: "refs/heads/feature" })]);
  assert.equal(gh.issues.length, 0);
  await run(gh, [res({ ref: "refs/heads/main" })]);
  assert.equal(gh.issues.length, 1);
});

test("another mode's update keeps the drifted mode's resource list", async () => {
  const gh = fakeGithub();
  await run(gh, [res({ mode: "code" })]);
  await run(gh, [res({ mode: "live", status: "preview-failed", changeCount: null, changes: [] })]);
  assert.match(gh.issues[0].body, /The `code` preview would change:/);
  assert.match(gh.issues[0].body, /`web`/);
  // Once code is clean its list goes, while live's failure keeps the issue open.
  await run(gh, [res({ mode: "code", status: "clean", changeCount: 0, changes: [] })]);
  assert.doesNotMatch(gh.issues[0].body, /would change/);
  assert.equal(gh.issues[0].state, "open");
});

test("state round-trips through the issue body", () => {
  const state = { project: "deploy/app", stack: "prod", modes: { live: { status: "drift", changeCount: 1, runUrl: RUN } } };
  assert.deepEqual(drift.parseState(drift.renderBody(state, res({}))), state);
  assert.equal(drift.parseState("no marker here"), null);
});

test("a malformed result fails loudly", async () => {
  const gh = fakeGithub();
  await assert.rejects(run(gh, [res({ status: "weird" })]), /malformed drift result/);
});
