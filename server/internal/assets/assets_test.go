package assets

import (
	"bytes"
	"github.com/google/uuid"
	"image"
	"image/png"
	"os"
	"testing"
)

func TestPNGAndAtomicStorage(t *testing.T) {
	var b bytes.Buffer
	png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 4, 4)))
	if e := ValidatePNG(b.Bytes()); e != nil {
		t.Fatal(e)
	}
	if e := ValidatePNG(b.Bytes()[:len(b.Bytes())-8]); e == nil {
		t.Fatal("truncated PNG accepted")
	}
	if e := ValidatePNG([]byte("not png")); e == nil {
		t.Fatal("invalid PNG accepted")
	}
	s := Store{t.TempDir()}
	id := uuid.NewString()
	if e := s.Put(id, "snapshot", b.Bytes()); e != nil {
		t.Fatal(e)
	}
	got, e := s.Read(id, "snapshot")
	if e != nil || !bytes.Equal(got, b.Bytes()) {
		t.Fatal("storage mismatch", e)
	}
	if _, e = s.Path("../../etc", "snapshot"); e == nil {
		t.Fatal("path traversal accepted")
	}
	if _, e = s.Path(id, "../../passwd"); e == nil {
		t.Fatal("kind traversal accepted")
	}
	p, _ := s.Path(id, "snapshot")
	stat, _ := os.Stat(p)
	if stat.Mode().Perm() != 0600 {
		t.Fatal("asset permissions", stat.Mode())
	}
}
func TestReadLimited(t *testing.T) {
	if _, e := ReadLimited(bytes.NewReader([]byte("1234")), 3); e == nil {
		t.Fatal("oversize accepted")
	}
}

func TestValidateGaussianPLY(t *testing.T) {
	header := "ply\nformat binary_little_endian 1.0\nelement vertex 1\n"
	for _, p := range []string{"x", "y", "z", "opacity", "f_dc_0", "f_dc_1", "f_dc_2", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"} {
		header += "property float " + p + "\n"
	}
	header += "end_header\n"
	b := append([]byte(header), make([]byte, 14*4)...)
	if e := ValidatePLY(b); e != nil {
		t.Fatal(e)
	}
	if e := ValidatePLY(b[:len(b)-1]); e == nil {
		t.Fatal("truncated PLY accepted")
	}
	if e := ValidatePLY([]byte("ply\nend_header\n")); e == nil {
		t.Fatal("non Gaussian PLY accepted")
	}
}
