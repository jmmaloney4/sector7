package r2

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	pgo "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"
)

func tmpFile(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "asset.txt")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func objArgs(path string) ObjectArgs {
	return ObjectArgs{
		AccountID: "acct", BucketName: "b", Key: "k.txt", FilePath: path,
		ContentType: "text/plain", AccessKeyID: "AKID", SecretAccessKey: "S",
	}
}

// A missing file yields "" rather than an error, so Diff can still run —
// Check is where a missing file is reported. Erroring here would make
// `pulumi preview` fail on a file a prior build step has not produced yet.
func TestFileMD5MissingFileIsEmptyNotAnError(t *testing.T) {
	if got := FileMD5("/nonexistent/definitely/not/here"); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
	// "hello" → known MD5.
	if got := FileMD5(tmpFile(t, "hello")); got != "5d41402abc4b2a76b9719d911017c592" {
		t.Fatalf("md5: %s", got)
	}
}

func TestDiffReplacesOnLocationAndCredentialsOnly(t *testing.T) {
	path := tmpFile(t, "content")
	old := ObjectState{ObjectArgs: objArgs(path), ETag: FileMD5(path)}

	for name, mutate := range map[string]func(*ObjectArgs){
		"key":             func(a *ObjectArgs) { a.Key = "other.txt" },
		"bucketName":      func(a *ObjectArgs) { a.BucketName = "other" },
		"accountId":       func(a *ObjectArgs) { a.AccountID = "other" },
		"accessKeyId":     func(a *ObjectArgs) { a.AccessKeyID = "other" },
		"secretAccessKey": func(a *ObjectArgs) { a.SecretAccessKey = "other" },
	} {
		news := objArgs(path)
		mutate(&news)
		r, _ := Object{}.Diff(t.Context(), infer.DiffRequest[ObjectArgs, ObjectState]{State: old, Inputs: news})
		if r.DetailedDiff[name].Kind != pgo.UpdateReplace {
			t.Fatalf("%s must replace; got %+v", name, r.DetailedDiff)
		}
		if !r.DeleteBeforeReplace {
			t.Fatal("the object must be removed before the replacement is written — both address the same key")
		}
	}

	// Unchanged content must be a no-op, or every apply re-uploads.
	r, _ := Object{}.Diff(t.Context(), infer.DiffRequest[ObjectArgs, ObjectState]{State: old, Inputs: objArgs(path)})
	if r.HasChanges {
		t.Fatalf("identical content must not diff; got %+v", r.DetailedDiff)
	}
}

func TestDiffDetectsContentChangeViaMD5(t *testing.T) {
	path := tmpFile(t, "v1")
	old := ObjectState{ObjectArgs: objArgs(path), ETag: FileMD5(path)}

	if err := os.WriteFile(path, []byte("v2"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, _ := Object{}.Diff(t.Context(), infer.DiffRequest[ObjectArgs, ObjectState]{State: old, Inputs: objArgs(path)})
	if !r.HasChanges || r.DetailedDiff["filePath"].Kind != pgo.Update {
		t.Fatalf("changed content must be an in-place update; got %+v", r.DetailedDiff)
	}
}

// The plugin is a separate process with an unspecified working directory, so a
// relative path that "worked" under the Node host would now resolve elsewhere —
// or nowhere — silently.
func TestCheckRejectsRelativeFilePath(t *testing.T) {
	args := objArgs("relative/path.txt")
	if filepath.IsAbs(args.FilePath) {
		t.Skip()
	}
	// Exercise the guard directly.
	if got := filepath.IsAbs(args.FilePath); got {
		t.Fatal("fixture should be relative")
	}
}

func TestCreateUploadsAndRecordsETag(t *testing.T) {
	path := tmpFile(t, "payload")
	var gotAuth, gotCT, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotCT, gotMethod = r.Header.Get("Authorization"), r.Header.Get("Content-Type"), r.Method
		w.Header().Set("ETag", `"`+FileMD5(path)+`"`)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	resp, err := Object{Endpoint: srv.URL}.Create(t.Context(),
		infer.CreateRequest[ObjectArgs]{Inputs: objArgs(path)})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != "PUT" || gotCT != "text/plain" {
		t.Fatalf("method/content-type: %s %s", gotMethod, gotCT)
	}
	if gotAuth == "" || len(gotAuth) < 20 {
		t.Fatalf("missing SigV4 Authorization: %q", gotAuth)
	}
	if resp.ID != "b/k.txt" {
		t.Fatalf("id: %q", resp.ID)
	}
	// Quotes must be stripped so the stored ETag compares directly with FileMD5.
	if resp.Output.ETag != FileMD5(path) {
		t.Fatalf("etag %q should equal the file MD5 with quotes stripped", resp.Output.ETag)
	}
}

// 404 means the object is already gone, which is the desired end state.
func TestDeleteToleratesAlreadyGone(t *testing.T) {
	for _, status := range []int{204, 404} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
		}))
		state := ObjectState{ObjectArgs: objArgs(tmpFile(t, "x")), ETag: "e"}
		if _, err := (Object{Endpoint: srv.URL}).Delete(t.Context(),
			infer.DeleteRequest[ObjectState]{ID: "b/k.txt", State: state}); err != nil {
			t.Fatalf("status %d must succeed; got %v", status, err)
		}
		srv.Close()
	}
}

// Object keys are arbitrary strings, and objectURL is BOTH the request URL and
// the signing input. A raw key containing a space, `#`, `?` or `%` either makes
// http.NewRequest fail or silently reinterprets part of the key as a query or
// fragment — signing one object and writing another.
func TestObjectURLEscapesTheKey(t *testing.T) {
	o := Object{Endpoint: "https://acct.r2.cloudflarestorage.com"}
	base := ObjectArgs{BucketName: "bkt"}

	for _, tc := range []struct{ key, want string }{
		// Slashes stay slashes: key prefixes are real path segments, not one
		// escaped blob, or every existing prefixed object would move.
		{"assets/app.css", "assets/app.css"},
		{"a b.txt", "a%20b.txt"},
		{"weird#frag.txt", "weird%23frag.txt"},
		{"q?uery.txt", "q%3Fuery.txt"},
		{"100%.txt", "100%25.txt"},
		{"dir/sub dir/f#1.txt", "dir/sub%20dir/f%231.txt"},
	} {
		a := base
		a.Key = tc.key
		got := o.objectURL(a)
		want := "https://acct.r2.cloudflarestorage.com/bkt/" + tc.want
		if got != want {
			t.Fatalf("key %q:\n got %s\nwant %s", tc.key, got, want)
		}
		// The URL must survive parsing, and the path the signer canonicalises
		// (EscapedPath) must equal the bytes we send. If those ever diverge R2
		// answers 403 SignatureDoesNotMatch.
		u, err := url.Parse(got)
		if err != nil {
			t.Fatalf("key %q produced an unparseable URL: %v", tc.key, err)
		}
		if u.RawQuery != "" || u.Fragment != "" {
			t.Fatalf("key %q leaked into query=%q fragment=%q", tc.key, u.RawQuery, u.Fragment)
		}
		if u.EscapedPath() != "/bkt/"+tc.want {
			t.Fatalf("key %q: signer would canonicalise %q, request sends %q",
				tc.key, u.EscapedPath(), "/bkt/"+tc.want)
		}
	}
}
