// Package onepassword implements the sector7 provider's 1Password Connect
// resources. Ported from packages/sector7/onepassword/item.ts.
package onepassword

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/checkutil"
	"github.com/jmmaloney4/sector7/provider/internal/httpx"
	"github.com/jmmaloney4/sector7/provider/internal/kube"
)

const (
	defaultDeployment = "onepassword-connect"
	defaultPort       = 8080
	defaultCategory   = "PASSWORD"
	defaultFieldType  = "CONCEALED"
)

// Item is a 1Password item managed through a Connect server reached by
// in-cluster port-forward.
type Item struct {
	Transport kube.Transport
}

// Field is one managed field on the item.
type Field struct {
	Label string `pulumi:"label"`
	// Value is secret. infer's secret walker recurses into nested structs, so
	// tagging it here does reach the schema — verified against
	// infer/apply_secrets.go.
	Value   string `pulumi:"value" provider:"secret"`
	Type    string `pulumi:"type,optional"`
	Purpose string `pulumi:"purpose,optional"`
}

// URL is one website URL on the item. 1Password's browser extension matches
// autofill candidates against these, so a LOGIN item without one never
// surfaces on the site it belongs to.
type URL struct {
	Href string `pulumi:"href"`
	// Label is the display name shown beside the URL (e.g. "tailnet").
	Label string `pulumi:"label,optional"`
	// Primary marks the URL used for "Open and fill". At most one URL may set
	// it; Check rejects more.
	Primary bool `pulumi:"primary,optional"`
}

type ItemArgs struct {
	// Kubeconfig is YAML; empty means the ambient default config.
	Kubeconfig     string  `pulumi:"kubeconfig,optional" provider:"secret"`
	ConnectToken   string  `pulumi:"connectToken" provider:"secret"`
	Namespace      string  `pulumi:"namespace"`
	DeploymentName string  `pulumi:"deploymentName,optional"`
	ConnectPort    int     `pulumi:"connectPort,optional"`
	Vault          string  `pulumi:"vault"`
	Title          string  `pulumi:"title"`
	Category       string  `pulumi:"category,optional"`
	Fields         []Field `pulumi:"fields"`
	// URLs are the item's website URLs. Unlike Fields these are replace-or-
	// preserve rather than reconciled: declaring them overwrites the item's url
	// list, omitting them leaves whatever is there alone. There is no
	// ManagedLabels equivalent to tell "I removed the url I used to manage"
	// apart from "this resource never managed urls", and silently dropping a
	// hand-added URL the first time an existing resource applies is the worse
	// of the two failures.
	URLs []URL `pulumi:"urls,optional"`
}

// ItemState deliberately does NOT embed ItemArgs, and so deliberately does not
// carry Fields.
//
// The dynamic provider this replaces never persisted field values. Its
// stateOuts (packages/sector7/onepassword/item.ts) listed the connection and
// identity inputs explicitly and stopped there, keeping only `managedLabels`
// (labels, not values) and `contentHash` (a digest over the values) — secret
// values never entered state at all. Embedding ItemArgs here silently reversed
// that: Create and Update both write ItemState{ItemArgs: a, …}, so every
// managed secret would be persisted. Encrypted, since Field.Value is tagged
// secret — but present, which is a weaker property than absent, and the reason
// contentHash is itself marked secret is precisely to avoid handing out an
// offline oracle over those values.
//
// It also matches what live state actually looks like. The five dynamic
// OnePasswordItems in gateway/ergon/matrix/litellm have no `fields` key in
// their outputs, so an ItemState requiring one cannot decode them and the alias
// retype would fail before it began.
//
// Nothing reads persisted Fields: Diff hashes the INCOMING fields and compares
// against the stored contentHash, and Update reconciles removals from
// ManagedLabels. Both match the TypeScript.
type ItemState struct {
	// Connection and identity inputs are echoed back, mirroring stateOuts in
	// the TypeScript. Fields is the deliberate omission.
	Kubeconfig     string `pulumi:"kubeconfig,optional" provider:"secret"`
	ConnectToken   string `pulumi:"connectToken" provider:"secret"`
	Namespace      string `pulumi:"namespace"`
	DeploymentName string `pulumi:"deploymentName,optional"`
	ConnectPort    int    `pulumi:"connectPort,optional"`
	Vault          string `pulumi:"vault"`
	Title          string `pulumi:"title"`
	Category       string `pulumi:"category,optional"`

	UUID     string `pulumi:"uuid"`
	ItemPath string `pulumi:"itemPath"`
	// ContentHash is secret: it is a SHA-256 over the field values, so exposing
	// it would give an offline oracle for guessing them.
	ContentHash string `pulumi:"contentHash" provider:"secret"`
	// ManagedLabels records which labels this resource owns, so a later update
	// can remove ones dropped from input without touching unmanaged fields.
	ManagedLabels []string `pulumi:"managedLabels"`
}

// target rebuilds the connection half of the inputs from stored state, for the
// one path that must reach Connect using what was persisted rather than what
// the program currently declares: Delete, which is handed no inputs at all.
// Fields is intentionally absent — nothing on that path needs it.
//
// Update is deliberately NOT a caller. It connects with the CURRENT inputs, so
// that a token rotation or cluster move takes effect on the same apply that
// declares it; the only thing it draws from prior state is ManagedLabels, for
// removal reconciliation. Delete is the sole caller — keep it that way, or the
// "what was persisted" framing above stops being true.
func (s ItemState) target() ItemArgs {
	return ItemArgs{
		Kubeconfig:     s.Kubeconfig,
		ConnectToken:   s.ConnectToken,
		Namespace:      s.Namespace,
		DeploymentName: s.DeploymentName,
		ConnectPort:    s.ConnectPort,
		Vault:          s.Vault,
		Title:          s.Title,
		Category:       s.Category,
	}
}

func (a *ItemArgs) Annotate(ann infer.Annotator) {
	ann.SetDefault(&a.DeploymentName, defaultDeployment)
	ann.SetDefault(&a.ConnectPort, defaultPort)
	ann.SetDefault(&a.Category, defaultCategory)
}

func (Item) Check(ctx context.Context, req infer.CheckRequest) (infer.CheckResponse[ItemArgs], error) {
	args, failures, err := infer.DefaultCheck[ItemArgs](ctx, req.NewInputs)
	if err != nil {
		return infer.CheckResponse[ItemArgs]{Inputs: args, Failures: failures}, err
	}
	fail := func(prop, reason string) {
		failures = append(failures, p.CheckFailure{Property: prop, Reason: reason})
	}
	checkutil.RequireNonEmpty(&failures,
		checkutil.NamedField{Name: "connectToken", Value: args.ConnectToken},
		checkutil.NamedField{Name: "namespace", Value: args.Namespace},
		checkutil.NamedField{Name: "vault", Value: args.Vault},
	)
	if strings.TrimSpace(args.Title) == "" {
		fail("title", "title must be a non-empty string")
	}
	if len(args.Fields) == 0 {
		fail("fields", "at least one field is required")
	} else {
		seen := map[string]bool{}
		for i, f := range args.Fields {
			switch {
			case f.Label == "":
				fail(fmt.Sprintf("fields[%d].label", i), "field label is required")
			case seen[f.Label]:
				// Fields are keyed by label when merged into the item, so
				// duplicates would silently collapse (last write wins) and
				// corrupt drift detection.
				fail(fmt.Sprintf("fields[%d].label", i), "duplicate field label: "+f.Label)
			default:
				seen[f.Label] = true
			}
		}

		// Collation guard. contentHash sorts fields by label to build the
		// canonical JSON, and the TypeScript it must match sorted with
		// String.prototype.localeCompare (onepassword/item.ts:293) — ICU
		// collation, not byte order. The two DISAGREE on mixed case:
		// localeCompare orders ["LiteLLM-Key","api-token"] as
		// ["api-token","LiteLLM-Key"]; Go's `<` gives the reverse. A divergence
		// changes the hash, which shows up as a spurious diff and rewrites a
		// live secret.
		//
		// Reimplementing ICU collation is the wrong fix: it is a large surface
		// (a fuzz of a case-folding approximation still diverged on 6.6% of
		// pairs, all involving `_` and `.`), and getting it subtly wrong would
		// change the hash for items that work correctly today.
		//
		// Instead, restrict multi-field items to the domain where the two
		// orders are provably identical. Byte order and localeCompare agree on
		// every pair of lowercase-kebab labels (verified by fuzzing 382,534
		// pairs under node: zero divergences). A single-field item has nothing
		// to sort, so its hash cannot depend on collation at all — which is why
		// the guard is skipped there, and why the live `LiteLLM-Key` item is
		// unaffected.
		if len(args.Fields) > 1 {
			for i, f := range args.Fields {
				if f.Label != "" && !kebabLabel.MatchString(f.Label) {
					fail(fmt.Sprintf("fields[%d].label", i), fmt.Sprintf(
						"multi-field items must use lowercase-kebab labels (got %q): "+
							"field order feeds contentHash, and byte order only matches "+
							"the TypeScript localeCompare sort within that domain", f.Label))
				}
			}
		}
	}

	primaries := 0
	for i, u := range args.URLs {
		href := strings.TrimSpace(u.Href)
		if href == "" {
			fail(fmt.Sprintf("urls[%d].href", i), "url href is required")
			continue
		}
		// A bare host ("qbittorrent-a.example.ts.net") parses fine as a
		// scheme-less URL but the browser extension will not match it, so the
		// item silently fails to autofill — the exact symptom urls exist to
		// prevent. Rejecting at Check turns that into a plan-time error.
		parsed, err := url.Parse(href)
		switch {
		case err != nil:
			fail(fmt.Sprintf("urls[%d].href", i), fmt.Sprintf("url href is not a valid URL: %v", err))
		case parsed.Scheme == "":
			fail(fmt.Sprintf("urls[%d].href", i), fmt.Sprintf(
				"url href must include a scheme (got %q; use https://%s)", href, href))
		case parsed.Host == "":
			fail(fmt.Sprintf("urls[%d].href", i), fmt.Sprintf("url href has no host (got %q)", href))
		}
		if u.Primary {
			primaries++
		}
	}
	if primaries > 1 {
		fail("urls", fmt.Sprintf(
			"at most one url may be primary (got %d); 1Password opens exactly one for \"Open and fill\"", primaries))
	}

	return infer.CheckResponse[ItemArgs]{Inputs: args, Failures: failures}, nil
}

// kebabLabel is the collation-safe label domain: lowercase alphanumerics and
// interior hyphens. Matches the lowercase-kebab contract garden's gateway
// already enforces on the only live multi-field item.
var kebabLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)

func (Item) Diff(_ context.Context, req infer.DiffRequest[ItemArgs, ItemState]) (p.DiffResponse, error) {
	olds, news := req.State, req.Inputs
	diffs := map[string]p.PropertyDiff{}

	// Identity is vault + title — the adoption key. A change there is a
	// different item, so it forces replacement.
	if olds.Vault != news.Vault {
		diffs["vault"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if olds.Title != news.Title {
		diffs["title"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}

	hash, err := ContentHash(news.Category, news.Fields, news.URLs)
	if err != nil {
		return p.DiffResponse{}, err
	}
	if hash != olds.ContentHash {
		diffs["fields"] = p.PropertyDiff{Kind: p.Update}
	}

	// Transport inputs do not change the item, so they never force replacement —
	// but they MUST still trigger an in-place update, or a token rotation or
	// cluster move is dropped and the stale value persists in state, breaking a
	// later update/delete.
	if olds.ConnectToken != news.ConnectToken ||
		olds.Kubeconfig != news.Kubeconfig ||
		olds.Namespace != news.Namespace ||
		olds.DeploymentName != news.DeploymentName ||
		olds.ConnectPort != news.ConnectPort {
		diffs["transport"] = p.PropertyDiff{Kind: p.Update}
	}

	return p.DiffResponse{
		HasChanges:   len(diffs) > 0,
		DetailedDiff: diffs,
		// Never delete-before-replace: a value or identity change must not drop
		// the item out from under consumers that reference it by path
		// mid-update.
		DeleteBeforeReplace: false,
	}, nil
}

// ContentHash reproduces computeContentHash from item.ts.
//
// This MUST be byte-identical to the TypeScript, or every existing item shows a
// spurious diff on the first apply after migration. Two Go/JS divergences are
// handled explicitly:
//
//   - Field order. Go's encoding/json sorts map keys alphabetically; JS
//     JSON.stringify uses insertion order. A struct with fields declared in the
//     TS order reproduces it.
//   - HTML escaping. Go escapes <, > and & by default; JS does not. Disabled
//     via Encoder.SetEscapeHTML(false).
//
// Sorting note: the TS sorts labels with localeCompare, which is not byte order
// for non-ASCII labels. Every label in use today is ASCII, where the two agree.
// A golden test pins the exact digest.
func ContentHash(category string, fields []Field, urls []URL) (string, error) {
	type canonicalField struct {
		Label   string  `json:"label"`
		Value   string  `json:"value"`
		Type    string  `json:"type"`
		Purpose *string `json:"purpose"`
	}
	type canonicalURL struct {
		Href    string `json:"href"`
		Label   string `json:"label"`
		Primary bool   `json:"primary"`
	}
	// `urls,omitempty` is load-bearing for backward compatibility, not style:
	// with no urls declared the key is omitted entirely, so the canonical JSON
	// — and therefore the digest — is byte-identical to what the pre-urls
	// implementation produced. Every item already in state hashes unchanged and
	// shows no diff. Only items that actually declare urls get a new shape.
	type canonical struct {
		Category string           `json:"category"`
		Fields   []canonicalField `json:"fields"`
		URLs     []canonicalURL   `json:"urls,omitempty"`
	}

	if category == "" {
		category = defaultCategory
	}
	out := canonical{Category: category, Fields: make([]canonicalField, 0, len(fields))}
	for _, f := range fields {
		ft := f.Type
		if ft == "" {
			ft = defaultFieldType
		}
		var purpose *string
		if f.Purpose != "" {
			pv := f.Purpose
			purpose = &pv
		}
		out.Fields = append(out.Fields, canonicalField{
			Label: f.Label, Value: f.Value, Type: ft, Purpose: purpose,
		})
	}
	sort.SliceStable(out.Fields, func(i, j int) bool {
		return out.Fields[i].Label < out.Fields[j].Label
	})

	// URLs are NOT sorted: unlike fields (a label-keyed map on the item, where
	// declaration order carries no meaning) the url list is ordered, and
	// reordering it is a real change the operator asked for. Hashing the
	// declared order makes that a diff instead of a silent no-op.
	for _, u := range urls {
		out.URLs = append(out.URLs, canonicalURL{
			Href: u.Href, Label: u.Label, Primary: u.Primary,
		})
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		return "", err
	}
	// Encode appends a newline that JSON.stringify does not produce.
	sum := sha256.Sum256(bytes.TrimRight(buf.Bytes(), "\n"))
	return hex.EncodeToString(sum[:]), nil
}

func (i Item) connect(ctx context.Context, a ItemArgs) (*httpx.Client, func(), error) {
	conn, err := i.Transport.Connect(ctx, kube.Target{
		Kubeconfig: a.Kubeconfig,
		Namespace:  a.Namespace,
		Deployment: a.DeploymentName,
		Port:       a.ConnectPort,
	})
	if err != nil {
		return nil, nil, err
	}
	return &httpx.Client{
		BaseURL:    conn.BaseURL,
		Bearer:     a.ConnectToken,
		HTTP:       &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 30 * time.Second},
		MaxRetries: 3,
	}, conn.Close, nil
}

// findItemIDByTitle adopts by title, refusing ambiguity.
//
// Titles are NOT unique within a vault, so adopting an arbitrary match could
// overwrite — or later delete — an unrelated, manually-created secret in a
// shared vault. Exactly one match adopts, zero creates, more than one is a hard
// error the operator must resolve. Same authorization reasoning as LiteLLM team
// aliases.
func (i Item) findItemIDByTitle(ctx context.Context, c *httpx.Client, vault, title string) (string, error) {
	filter := url.QueryEscape(fmt.Sprintf(`title eq "%s"`, strings.ReplaceAll(title, `"`, `\"`)))
	var items []map[string]any
	if err := c.Do(ctx, "GET", fmt.Sprintf("/v1/vaults/%s/items?filter=%s", vault, filter), nil, &items, true); err != nil {
		return "", err
	}
	// Re-check the title exactly; do not trust the server filter to be strict.
	var matches []map[string]any
	for _, it := range items {
		if t, _ := it["title"].(string); t == title {
			matches = append(matches, it)
		}
	}
	if len(matches) > 1 {
		return "", fmt.Errorf(
			"sector7: 1Password vault %s contains %d items titled %q; refusing to adopt ambiguously. "+
				"Remove the duplicate(s) or give this item a unique title", vault, len(matches), title)
	}
	if len(matches) == 0 {
		return "", nil
	}
	id, _ := matches[0]["id"].(string)
	return id, nil
}

func managedField(f Field) map[string]any {
	ft := f.Type
	if ft == "" {
		ft = defaultFieldType
	}
	m := map[string]any{"label": f.Label, "type": ft, "value": f.Value}
	if f.Purpose != "" {
		m["purpose"] = f.Purpose
	}
	return m
}

// buildMergedItemBody upserts the managed fields into whatever the item already
// has, so unmanaged fields, sections, urls and tags survive. A blind rebuild
// would silently drop them — which matters most when adopting a pre-existing,
// hand-created item.
func buildMergedItemBody(existing map[string]any, a ItemArgs, id string, priorManagedLabels []string) map[string]any {
	byLabel := map[string]map[string]any{}
	order := []string{}
	if raw, ok := existing["fields"].([]any); ok {
		for _, e := range raw {
			if f, ok := e.(map[string]any); ok {
				if l, _ := f["label"].(string); l != "" {
					if _, seen := byLabel[l]; !seen {
						order = append(order, l)
					}
					byLabel[l] = f
				}
			}
		}
	}

	// Remove fields we previously managed that are no longer declared, so the
	// item reconciles to the declared state. Fields we never managed are left
	// alone.
	declared := map[string]bool{}
	for _, f := range a.Fields {
		declared[f.Label] = true
	}
	for _, l := range priorManagedLabels {
		if !declared[l] {
			delete(byLabel, l)
		}
	}

	for _, f := range a.Fields {
		merged := map[string]any{}
		for k, v := range byLabel[f.Label] {
			merged[k] = v
		}
		for k, v := range managedField(f) {
			merged[k] = v
		}
		if _, seen := byLabel[f.Label]; !seen {
			order = append(order, f.Label)
		}
		byLabel[f.Label] = merged
	}

	fields := make([]any, 0, len(byLabel))
	for _, l := range order {
		if f, ok := byLabel[l]; ok {
			fields = append(fields, f)
		}
	}

	body := map[string]any{}
	for k, v := range existing {
		body[k] = v
	}
	body["id"] = id
	body["vault"] = map[string]any{"id": a.Vault}
	body["title"] = a.Title
	body["category"] = a.Category
	body["fields"] = fields
	// Replace-or-preserve, per ItemArgs.URLs: only overwrite when the program
	// declares urls. The `existing` copy above already carried the item's
	// current list through, so omitting them leaves it untouched.
	if len(a.URLs) > 0 {
		body["urls"] = urlsToAny(a.URLs)
	}
	return body
}

func managedURL(u URL) map[string]any {
	m := map[string]any{"href": u.Href}
	if u.Label != "" {
		m["label"] = u.Label
	}
	// Only sent when true: Connect treats primary as an at-most-one flag across
	// the list, and writing `false` explicitly on every entry is how you end up
	// clearing a primary the operator did want.
	if u.Primary {
		m["primary"] = true
	}
	return m
}

func urlsToAny(urls []URL) []any {
	out := make([]any, 0, len(urls))
	for _, u := range urls {
		out = append(out, managedURL(u))
	}
	return out
}

func (i Item) Create(ctx context.Context, req infer.CreateRequest[ItemArgs]) (infer.CreateResponse[ItemState], error) {
	out := infer.CreateResponse[ItemState]{Output: stateOuts(req.Inputs, "", "")}
	if req.DryRun {
		return out, nil
	}
	a := req.Inputs

	c, done, err := i.connect(ctx, a)
	if err != nil {
		return out, err
	}
	defer done()

	// Find-or-create. Adoption is what makes a safe cutover from a hand-created
	// or otherwise unmanaged item possible.
	existing, err := i.findItemIDByTitle(ctx, c, a.Vault, a.Title)
	if err != nil {
		return out, err
	}

	uuid := existing
	if existing != "" {
		var current map[string]any
		if err := c.Do(ctx, "GET", fmt.Sprintf("/v1/vaults/%s/items/%s", a.Vault, existing), nil, &current, true); err != nil {
			return out, err
		}
		// First reconcile of an adopted item: we have no record of what we
		// managed before, so remove nothing — only upsert.
		body := buildMergedItemBody(current, a, existing, nil)
		if err := c.Do(ctx, "PUT", fmt.Sprintf("/v1/vaults/%s/items/%s", a.Vault, existing), body, nil, true); err != nil {
			return out, err
		}
	} else {
		body := map[string]any{
			"vault":    map[string]any{"id": a.Vault},
			"title":    a.Title,
			"category": a.Category,
			"fields":   fieldsToAny(a.Fields),
		}
		if len(a.URLs) > 0 {
			body["urls"] = urlsToAny(a.URLs)
		}
		var created map[string]any
		// Never retried: a retried create after a timeout that actually
		// succeeded would leave a duplicate item, which findItemIDByTitle would
		// then refuse to adopt as ambiguous.
		if err := c.Do(ctx, "POST", fmt.Sprintf("/v1/vaults/%s/items", a.Vault), body, &created, false); err != nil {
			return out, err
		}
		uuid, _ = created["id"].(string)
		if uuid == "" {
			return out, fmt.Errorf("sector7: 1Password Connect create returned no item id")
		}
	}

	hash, err := ContentHash(a.Category, a.Fields, a.URLs)
	if err != nil {
		return out, err
	}
	out.ID = uuid
	out.Output = stateOuts(a, uuid, hash)
	return out, nil
}

func (i Item) Update(ctx context.Context, req infer.UpdateRequest[ItemArgs, ItemState]) (infer.UpdateResponse[ItemState], error) {
	a := req.Inputs
	hash, err := ContentHash(a.Category, a.Fields, a.URLs)
	if err != nil {
		return infer.UpdateResponse[ItemState]{}, err
	}
	out := infer.UpdateResponse[ItemState]{Output: stateOuts(a, req.ID, hash)}
	if req.DryRun {
		return out, nil
	}

	c, done, err := i.connect(ctx, a)
	if err != nil {
		return out, err
	}
	defer done()

	var current map[string]any
	if err := c.Do(ctx, "GET", fmt.Sprintf("/v1/vaults/%s/items/%s", a.Vault, req.ID), nil, &current, true); err != nil {
		return out, err
	}
	// Merge into the live item so unmanaged fields survive, while removing
	// fields we previously managed but that were dropped from input.
	body := buildMergedItemBody(current, a, req.ID, req.State.ManagedLabels)
	if err := c.Do(ctx, "PUT", fmt.Sprintf("/v1/vaults/%s/items/%s", a.Vault, req.ID), body, nil, true); err != nil {
		return out, err
	}
	return out, nil
}

func (i Item) Delete(ctx context.Context, req infer.DeleteRequest[ItemState]) (infer.DeleteResponse, error) {
	c, done, err := i.connect(ctx, req.State.target())
	if err != nil {
		return infer.DeleteResponse{}, err
	}
	defer done()

	err = c.Do(ctx, "DELETE", fmt.Sprintf("/v1/vaults/%s/items/%s", req.State.Vault, req.ID), nil, nil, true)
	if err != nil {
		// A 404 means the item is already gone — manually removed, or an adopted
		// pre-existing item deleted externally. Treat it as success so
		// `pulumi destroy` is idempotent.
		var he *httpx.Error
		if ok := asHTTPError(err, &he); ok && he.Status == http.StatusNotFound {
			return infer.DeleteResponse{}, nil
		}
		return infer.DeleteResponse{}, err
	}
	return infer.DeleteResponse{}, nil
}

// asHTTPError unwraps err to an *httpx.Error.
//
// errors.As, not a bare type assertion: httpx returns *Error unwrapped today,
// but one fmt.Errorf("…: %w") added anywhere in that client would make a bare
// assertion silently stop matching. The only consumer is Delete's 404-tolerance
// branch, and losing it does not look like a bug — it is `pulumi destroy`
// failing on an item that was already removed out of band, which keeps the
// resource in state and reds every subsequent `up`.
func asHTTPError(err error, into **httpx.Error) bool {
	return errors.As(err, into)
}

func fieldsToAny(fields []Field) []any {
	out := make([]any, 0, len(fields))
	for _, f := range fields {
		out = append(out, managedField(f))
	}
	return out
}

func stateOuts(a ItemArgs, uuid, contentHash string) ItemState {
	labels := make([]string, 0, len(a.Fields))
	for _, f := range a.Fields {
		labels = append(labels, f.Label)
	}
	return ItemState{
		Kubeconfig:     a.Kubeconfig,
		ConnectToken:   a.ConnectToken,
		Namespace:      a.Namespace,
		DeploymentName: a.DeploymentName,
		ConnectPort:    a.ConnectPort,
		Vault:          a.Vault,
		Title:          a.Title,
		Category:       a.Category,
		UUID:           uuid,
		ItemPath:       fmt.Sprintf("vaults/%s/items/%s", a.Vault, uuid),
		ContentHash:    contentHash,
		ManagedLabels:  labels,
	}
}
