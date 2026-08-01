package litellm

import "github.com/jmmaloney4/sector7/provider/internal/httpx"

// httpxClient aliases the shared client so resource code reads cleanly.
type httpxClient = httpx.Client

// teamsFrom normalises /team/list, whose shape varies by LiteLLM version:
// a bare array, {teams: [...]}, or {data: [...]}. Entries that are not objects
// are skipped, matching the TypeScript guard.
func teamsFrom(raw any) []map[string]any {
	var list []any
	switch v := raw.(type) {
	case []any:
		list = v
	case map[string]any:
		if t, ok := v["teams"].([]any); ok {
			list = t
		} else if d, ok := v["data"].([]any); ok {
			list = d
		}
	}
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// orEmptySlice / orEmptyMap reproduce the `?? []` / `?? {}` normalisation the
// TS wrapper applied before handing inputs to the dynamic provider. Sending
// JSON null where the old implementation sent [] or {} would be a wire-level
// difference LiteLLM may treat as "leave unchanged".
func orEmptySlice(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func orEmptyMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

// keyHashesFrom normalises /key/list, whose shape varies by LiteLLM version:
// a bare array, {keys: [...]}, or {data: [...]}. Each entry may be a plain
// string hash or an object carrying `token` or `key_name`.
func keyHashesFrom(raw any) []string {
	var list []any
	switch v := raw.(type) {
	case []any:
		list = v
	case map[string]any:
		if k, ok := v["keys"].([]any); ok {
			list = k
		} else if d, ok := v["data"].([]any); ok {
			list = d
		}
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		var h string
		switch e := item.(type) {
		case string:
			h = e
		case map[string]any:
			if t, ok := e["token"].(string); ok {
				h = t
			} else if n, ok := e["key_name"].(string); ok {
				h = n
			}
		}
		if h != "" {
			out = append(out, h)
		}
	}
	return out
}
