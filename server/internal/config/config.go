package config

import (
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func LoadDotEnv() {
	path := Env("WS_ENV_FILE", filepath.Join(RootDir(), ".env"))
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	loaded := 0
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key, value := strings.TrimSpace(line[:eq]), strings.TrimSpace(line[eq+1:])
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		_ = os.Setenv(key, value)
		loaded++
	}
	if loaded > 0 {
		log.Printf("loaded %d vars from %s", loaded, path)
	}
}

func RootDir() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	if filepath.Base(wd) == "server" {
		return filepath.Dir(wd)
	}
	return wd
}

func Env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func EnvInt(name string, fallback, min, max int) int {
	parsed, err := strconv.Atoi(Env(name, strconv.Itoa(fallback)))
	if err != nil {
		return fallback
	}
	if parsed < min {
		return min
	}
	if parsed > max {
		return max
	}
	return parsed
}

func EnvFloat(name string, fallback float64) float64 {
	parsed, err := strconv.ParseFloat(Env(name, strconv.FormatFloat(fallback, 'f', -1, 64)), 64)
	if err != nil {
		return fallback
	}
	return parsed
}
