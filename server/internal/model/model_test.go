package model

import (
	"encoding/json"
	"strings"
	"testing"
)

const validTabs = `[{"id":"build-1","name":"Courtyard","type":"build","snapshot":{"prims":{"version":4,"ground":{"size":100,"complete":true,"strokes":[{"mode":"paint","color":"#abcdef","radius":1,"closed":false,"points":[[0,0],[1,1]]}]},"primitives":[{"type":"box","position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#abcdef","support":null,"supportAxis":{"name":"y","sign":1}}]},"baseGroundColor":"#ffffff","prompt":"garden"}}]`

func TestTabs(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		ok        bool
	}{
		{"valid build", validTabs, true}, {"empty", "[]", true}, {"null", "null", false}, {"unknown field", strings.Replace(validTabs, `"name":"Courtyard"`, `"unknown":true,"name":"Courtyard"`, 1), false},
		{"short vector", strings.Replace(validTabs, `"position":[0,0,0]`, `"position":[0,0]`, 1), false}, {"long vector", strings.Replace(validTabs, `"position":[0,0,0]`, `"position":[0,0,0,1]`, 1), false},
		{"negative scale", strings.Replace(validTabs, `"scale":[1,1,1]`, `"scale":[1,-1,1]`, 1), false}, {"self support", strings.Replace(validTabs, `"support":null`, `"support":0`, 1), false},
		{"invalid mode", strings.Replace(validTabs, `"mode":"paint"`, `"mode":"execute"`, 1), false}, {"duplicate ID", "[" + strings.Trim(validTabs, "[]") + "," + strings.Trim(validTabs, "[]") + "]", false},
		{"splat", `[{"id":"s1","name":"View","type":"splat","job_id":"11111111-1111-4111-8111-111111111111"}]`, true},
		{"splat URL", `[{"id":"s1","name":"View","type":"splat","job_id":"https://example.com/file"}]`, false},
		{"trailing JSON", validTabs + "{}", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, e := ParseTabs(json.RawMessage(tc.raw))
			if (e == nil) != tc.ok {
				t.Fatalf("error=%v want valid=%v", e, tc.ok)
			}
		})
	}
}
func TestSupportCycle(t *testing.T) {
	var tabs []Tab
	json.Unmarshal([]byte(validTabs), &tabs)
	p := tabs[0].Snapshot.Prims.Primitives[0]
	a, b := 1, 0
	p.Support = &a
	q := p
	q.Support = &b
	tabs[0].Snapshot.Prims.Primitives = []Primitive{p, q}
	if e := tabs[0].Snapshot.Validate(); e == nil {
		t.Fatal("cycle accepted")
	}
}
