package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr, DatabaseURL, RedisURL, GoogleClientID, DataDir, ClientDir string
	TemporalAddress, TemporalNamespace, TaskQueue                   string
	FALKey, FALURL, FALModel, TripoURL                              string
	Origins                                                         []string
	SessionTTL                                                      time.Duration
	MaxActiveJobs, DailyLimit, TripoSteps, TripoGaussians           int
}

func env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
func Load() (Config, error) {
	c := Config{Addr: env("WS_ADDR", ":"+env("PORT", "8067")), DatabaseURL: os.Getenv("DATABASE_URL"), RedisURL: env("REDIS_URL", "redis://127.0.0.1:6379/0"), GoogleClientID: os.Getenv("WS_GOOGLE_CLIENT_ID"), DataDir: env("WS_DATA_DIR", "./output"), ClientDir: env("WS_CLIENT_DIR", "../client"), TemporalAddress: env("TEMPORAL_ADDRESS", "127.0.0.1:7233"), TemporalNamespace: env("TEMPORAL_NAMESPACE", "worldsplat"), TaskQueue: env("TEMPORAL_TASK_QUEUE", "worldsplat-render"), FALKey: os.Getenv("FAL_KEY"), FALURL: env("WS_FAL_URL", "https://queue.fal.run"), FALModel: env("WS_FAL_MODEL", "fal-ai/flux-2/klein/4b/edit"), TripoURL: env("WS_TRIPO_URL", "http://127.0.0.1:7860")}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL is required")
	}
	var err error
	c.SessionTTL, err = time.ParseDuration(env("WS_SESSION_TTL", "720h"))
	if err != nil || c.SessionTTL < time.Minute {
		return c, fmt.Errorf("WS_SESSION_TTL must be at least 1m")
	}
	for _, x := range []struct {
		k           string
		p           *int
		d, min, max int
	}{{"WS_MAX_ACTIVE_JOBS", &c.MaxActiveJobs, 2, 1, 100}, {"WS_DAILY_GENERATION_LIMIT", &c.DailyLimit, 10, 1, 100000}, {"WS_TRIPO_STEPS", &c.TripoSteps, 20, 1, 50}, {"WS_TRIPO_GAUSSIANS", &c.TripoGaussians, 131072, 32768, 262144}} {
		*x.p, err = strconv.Atoi(env(x.k, strconv.Itoa(x.d)))
		if err != nil || *x.p < x.min || *x.p > x.max {
			return c, fmt.Errorf("invalid %s", x.k)
		}
	}
	if c.TripoGaussians != 32768 && c.TripoGaussians != 65536 && c.TripoGaussians != 131072 && c.TripoGaussians != 262144 {
		return c, fmt.Errorf("unsupported WS_TRIPO_GAUSSIANS")
	}
	for _, s := range strings.Split(os.Getenv("WS_ALLOWED_ORIGINS"), ",") {
		if s = strings.TrimSpace(s); s != "" {
			u, e := url.Parse(s)
			if e != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
				return c, fmt.Errorf("invalid allowed origin")
			}
			c.Origins = append(c.Origins, s)
		}
	}
	for _, s := range []string{c.FALURL, c.TripoURL} {
		u, e := url.Parse(s)
		if e != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
			return c, fmt.Errorf("invalid provider URL")
		}
	}
	return c, nil
}
