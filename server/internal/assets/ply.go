package assets

import (
	"bytes"
	"fmt"
	"strconv"
	"strings"
)

// ValidatePLY checks the binary Gaussian layout TripoSplat promises, including truncation.
func ValidatePLY(b []byte) error {
	if int64(len(b)) > MaxSplat {
		return fmt.Errorf("splat exceeds 128 MiB")
	}
	end := bytes.Index(b[:min(len(b), 65536)], []byte("end_header\n"))
	marker := len("end_header\n")
	if end < 0 {
		end = bytes.Index(b[:min(len(b), 65536)], []byte("end_header\r\n"))
		marker = len("end_header\r\n")
	}
	if end < 0 || !bytes.HasPrefix(b, []byte("ply")) {
		return fmt.Errorf("invalid PLY header")
	}
	lines := strings.Split(strings.ReplaceAll(string(b[:end]), "\r\n", "\n"), "\n")
	count, stride := 0, 0
	format := false
	props := map[string]bool{}
	for _, line := range lines {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "format":
			format = len(f) == 3 && f[1] == "binary_little_endian" && f[2] == "1.0"
		case "element":
			if len(f) != 3 || f[1] != "vertex" || count != 0 {
				return fmt.Errorf("unsupported PLY element")
			}
			var e error
			count, e = strconv.Atoi(f[2])
			if e != nil || count < 1 || count > 1000000 {
				return fmt.Errorf("invalid PLY vertex count")
			}
		case "property":
			if len(f) != 3 || f[1] != "float" || props[f[2]] {
				return fmt.Errorf("unsupported PLY property")
			}
			props[f[2]] = true
			stride += 4
		}
	}
	for _, p := range []string{"x", "y", "z", "opacity", "f_dc_0", "f_dc_1", "f_dc_2", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"} {
		if !props[p] {
			return fmt.Errorf("PLY is missing Gaussian property %s", p)
		}
	}
	if !format || count == 0 || len(b)-end-marker != count*stride {
		return fmt.Errorf("invalid or truncated binary Gaussian PLY")
	}
	return nil
}
