package r2

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"
)

// Object uploads a local file to an R2 bucket.
type Object struct {
	// Endpoint overrides the R2 endpoint. Tests only.
	Endpoint string
}

type ObjectArgs struct {
	AccountID  string `pulumi:"accountId"`
	BucketName string `pulumi:"bucketName"`
	Key        string `pulumi:"key"`
	// FilePath must be ABSOLUTE. See Check.
	FilePath        string `pulumi:"filePath"`
	ContentType     string `pulumi:"contentType"`
	AccessKeyID     string `pulumi:"accessKeyId" provider:"secret"`
	SecretAccessKey string `pulumi:"secretAccessKey" provider:"secret"`
}

type ObjectState struct {
	ObjectArgs
	// ETag is the MD5 hex digest of the uploaded content, matching the S3/R2
	// ETag format. Compared on the next Diff to detect content changes.
	ETag string `pulumi:"etag"`
}

func (Object) Check(ctx context.Context, req infer.CheckRequest) (infer.CheckResponse[ObjectArgs], error) {
	args, failures, err := infer.DefaultCheck[ObjectArgs](ctx, req.NewInputs)
	if err != nil {
		return infer.CheckResponse[ObjectArgs]{Inputs: args, Failures: failures}, err
	}
	fail := func(prop, reason string) {
		failures = append(failures, p.CheckFailure{Property: prop, Reason: reason})
	}

	for _, f := range []struct{ name, val string }{
		{"accountId", args.AccountID}, {"bucketName", args.BucketName},
		{"key", args.Key}, {"filePath", args.FilePath},
		{"accessKeyId", args.AccessKeyID}, {"secretAccessKey", args.SecretAccessKey},
	} {
		if f.val == "" {
			fail(f.name, f.name+" is required")
		}
	}

	if args.FilePath != "" {
		// A relative path is rejected outright, which the dynamic provider did
		// not need to do: it ran inside the Pulumi Node host, so relative paths
		// resolved against the program directory. A plugin is a separate process
		// with an unspecified working directory, so the same input would resolve
		// somewhere else — or nowhere — silently. Callers must pass an absolute
		// path (uploadAssets should path.resolve() first).
		if !filepath.IsAbs(args.FilePath) {
			fail("filePath", "filePath must be absolute — the provider runs as a separate process with an unspecified working directory")
		} else if info, err := os.Stat(args.FilePath); err != nil {
			fail("filePath", "file does not exist: "+args.FilePath)
		} else if !info.Mode().IsRegular() {
			fail("filePath", "filePath must be a regular file: "+args.FilePath)
		}
	}

	return infer.CheckResponse[ObjectArgs]{Inputs: args, Failures: failures}, nil
}

// FileMD5 returns the MD5 hex digest of a file's contents, or "" when the file
// is missing.
//
// A missing file yields "" rather than an error so Diff can still run — Check
// is where a missing file is reported. Erroring here would make `pulumi
// preview` fail on a file that a prior build step has not produced yet.
func FileMD5(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := md5.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (Object) Diff(_ context.Context, req infer.DiffRequest[ObjectArgs, ObjectState]) (p.DiffResponse, error) {
	olds, news := req.State, req.Inputs
	diffs := map[string]p.PropertyDiff{}

	// Identity is the object's location and the credentials used to write it.
	for name, changed := range map[string]bool{
		"key":             olds.Key != news.Key,
		"bucketName":      olds.BucketName != news.BucketName,
		"accountId":       olds.AccountID != news.AccountID,
		"accessKeyId":     olds.AccessKeyID != news.AccessKeyID,
		"secretAccessKey": olds.SecretAccessKey != news.SecretAccessKey,
	} {
		if changed {
			diffs[name] = p.PropertyDiff{Kind: p.UpdateReplace}
		}
	}

	if md5sum := FileMD5(news.FilePath); md5sum != "" && md5sum != olds.ETag {
		diffs["filePath"] = p.PropertyDiff{Kind: p.Update}
	}
	if olds.ContentType != news.ContentType {
		diffs["contentType"] = p.PropertyDiff{Kind: p.Update}
	}

	return p.DiffResponse{
		HasChanges:   len(diffs) > 0,
		DetailedDiff: diffs,
		// The object must be gone before the replacement is written, since both
		// address the same key.
		DeleteBeforeReplace: true,
	}, nil
}

func (o Object) endpoint(a ObjectArgs) string {
	if o.Endpoint != "" {
		return o.Endpoint
	}
	return fmt.Sprintf("https://%s.r2.cloudflarestorage.com", a.AccountID)
}

func (o Object) objectURL(a ObjectArgs) string {
	return fmt.Sprintf("%s/%s/%s", o.endpoint(a), a.BucketName, a.Key)
}

func (o Object) upload(ctx context.Context, a ObjectArgs) (string, error) {
	body, err := os.ReadFile(a.FilePath)
	if err != nil {
		return "", fmt.Errorf("sector7: reading %s: %w", a.FilePath, err)
	}
	url := o.objectURL(a)
	headers, err := signedHeaders("PUT", url,
		SigV4Credentials{AccessKeyID: a.AccessKeyID, SecretAccessKey: a.SecretAccessKey},
		body, a.ContentType, time.Now())
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, "PUT", url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("sector7: R2 PUT %s/%s: %w", a.BucketName, a.Key, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Body deliberately omitted — it can echo request details.
		return "", fmt.Errorf("sector7: R2 PUT %s/%s failed: %d", a.BucketName, a.Key, resp.StatusCode)
	}

	// Prefer the server's ETag, falling back to a local MD5. Quotes are
	// stripped so the stored value compares directly against FileMD5.
	etag := strings.Trim(resp.Header.Get("ETag"), `"`)
	if etag == "" {
		sum := md5.Sum(body)
		etag = hex.EncodeToString(sum[:])
	}
	return etag, nil
}

func (o Object) Create(ctx context.Context, req infer.CreateRequest[ObjectArgs]) (infer.CreateResponse[ObjectState], error) {
	out := infer.CreateResponse[ObjectState]{Output: ObjectState{ObjectArgs: req.Inputs}}
	if req.DryRun {
		return out, nil
	}
	etag, err := o.upload(ctx, req.Inputs)
	if err != nil {
		return out, err
	}
	out.ID = fmt.Sprintf("%s/%s", req.Inputs.BucketName, req.Inputs.Key)
	out.Output = ObjectState{ObjectArgs: req.Inputs, ETag: etag}
	return out, nil
}

func (o Object) Update(ctx context.Context, req infer.UpdateRequest[ObjectArgs, ObjectState]) (infer.UpdateResponse[ObjectState], error) {
	out := infer.UpdateResponse[ObjectState]{Output: ObjectState{ObjectArgs: req.Inputs, ETag: req.State.ETag}}
	if req.DryRun {
		return out, nil
	}
	etag, err := o.upload(ctx, req.Inputs)
	if err != nil {
		return out, err
	}
	out.Output.ETag = etag
	return out, nil
}

func (o Object) Delete(ctx context.Context, req infer.DeleteRequest[ObjectState]) (infer.DeleteResponse, error) {
	a := req.State.ObjectArgs
	url := o.objectURL(a)
	headers, err := signedHeaders("DELETE", url,
		SigV4Credentials{AccessKeyID: a.AccessKeyID, SecretAccessKey: a.SecretAccessKey},
		nil, "", time.Now())
	if err != nil {
		return infer.DeleteResponse{}, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "DELETE", url, nil)
	if err != nil {
		return infer.DeleteResponse{}, err
	}
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: time.Minute}
	resp, err := client.Do(httpReq)
	if err != nil {
		return infer.DeleteResponse{}, fmt.Errorf("sector7: R2 DELETE %s/%s: %w", a.BucketName, a.Key, err)
	}
	defer resp.Body.Close()

	// 204 is success; 404 means the object is already gone, which is the
	// desired end state — so destroy and replacement stay idempotent.
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound ||
		(resp.StatusCode >= 200 && resp.StatusCode < 300) {
		return infer.DeleteResponse{}, nil
	}
	return infer.DeleteResponse{}, fmt.Errorf("sector7: R2 DELETE %s/%s failed: %d", a.BucketName, a.Key, resp.StatusCode)
}
