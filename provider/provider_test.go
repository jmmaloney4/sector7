package provider

import (
	"reflect"
	"testing"

	"github.com/jmmaloney4/sector7/provider/internal/kube"
)

// kubeBackedResourceCount is how many registered resources reach a
// ClusterIP-only Service through a port-forward: litellm's TeamRecord and
// KeyRecord, onepassword's Item, and attic's Cache.
//
// Deliberately hardcoded. If you add a resource with a kube.Transport field
// this test fails until you bump it, which is the point: the bump is the
// moment you confirm the new resource is actually wired in resources() rather
// than registered as a bare struct literal.
const kubeBackedResourceCount = 4

// Every resource carrying a kube.Transport field must be registered WITH a
// transport, not as a bare struct literal.
//
// This is a structural check rather than a behavioural one because the bug it
// guards is structural, and nothing behavioural caught it. `litellm.KeyRecord{}`
// and three siblings shipped with a nil Transport from the provider's first
// release and survived five of them:
//
//   - every unit test constructs these types with an explicit kube.Fake, so
//     the zero-value path is never exercised;
//   - Check and Diff never touch the transport, so `pulumi preview` and
//     `pulumi up` stayed green as long as state was byte-identical — which is
//     exactly what the alias migration was engineered to produce.
//
// The first operation to actually open a port-forward was a `pulumi refresh`
// against litellm/prod, after the migration had already landed, and it took
// the whole provider process down:
//
//	panic: runtime error: invalid memory address or nil pointer dereference
//	  [signal SIGSEGV: segmentation violation]
//	  ...provider/litellm.connect(...)      client.go:43
//	  ...provider/litellm.KeyRecord.Read(...) key.go:315
//
// A nil interface field is invisible to the compiler, and invisible to any
// test that dutifully populates it. Hence reflection over the real
// registration list.
func TestEveryKubeBackedResourceHasATransport(t *testing.T) {
	transportType := reflect.TypeOf((*kube.Transport)(nil)).Elem()

	checked := 0
	for i, res := range resources(&kube.SPDYTransport{}) {
		rsc := registeredValue(t, i, res)

		for j := range rsc.NumField() {
			if rsc.Type().Field(j).Type != transportType {
				continue
			}
			checked++
			if rsc.Field(j).IsNil() {
				t.Errorf("%s.%s is nil: this segfaults the entire provider process "+
					"on the first operation that opens a port-forward",
					rsc.Type(), rsc.Type().Field(j).Name)
			}
		}
	}

	// Guard the guard. If the reflection below ever stops finding the
	// registered values — a pulumi-go-provider refactor, a resource switched to
	// a pointer receiver — every assertion above silently stops running and
	// this test passes while asserting nothing.
	if checked != kubeBackedResourceCount {
		t.Fatalf("inspected %d kube.Transport fields, expected %d: either a "+
			"port-forwarded resource was added without updating "+
			"kubeBackedResourceCount, or this test can no longer see what "+
			"resources() registers", checked, kubeBackedResourceCount)
	}
}

// registeredValue digs the resource value back out of an infer.InferredResource.
//
// infer.Resource stores it as derivedResourceController.receiver (*R), with no
// exported accessor. Reading it through reflection is the price of asserting
// against what New() ACTUALLY registers instead of against a reconstruction —
// and a reconstruction is worthless here, since the bug was that the real list
// and a correct-looking one had diverged.
func registeredValue(t *testing.T, i int, res any) reflect.Value {
	t.Helper()

	v := reflect.ValueOf(res)
	if v.Kind() == reflect.Pointer {
		v = v.Elem()
	}
	receiver := v.FieldByName("receiver")
	if !receiver.IsValid() || receiver.Kind() != reflect.Pointer {
		t.Fatalf("resource %d (%T): cannot reach derivedResourceController.receiver; "+
			"pulumi-go-provider's internals changed and this test is now blind", i, res)
	}
	rsc := receiver.Elem()
	if rsc.Kind() != reflect.Struct {
		t.Fatalf("resource %d (%T): receiver points at %s, not a struct", i, res, rsc.Kind())
	}
	return rsc
}
