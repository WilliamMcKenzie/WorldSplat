package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/api/idtoken"
	"worldsplat/internal/model"
)

var ErrUnauthorized = errors.New("invalid or expired session")
var ErrDisabled = errors.New("Google login is not configured")

type Identity struct{ Subject, Email, Name string }
type Verifier interface {
	Verify(context.Context, string) (Identity, error)
}
type Google struct{ Audience string }

func (g Google) Verify(ctx context.Context, token string) (Identity, error) {
	if g.Audience == "" {
		return Identity{}, ErrDisabled
	}
	p, e := idtoken.Validate(ctx, token, g.Audience)
	if e != nil {
		return Identity{}, ErrUnauthorized
	}
	if p.Issuer != "accounts.google.com" && p.Issuer != "https://accounts.google.com" {
		return Identity{}, ErrUnauthorized
	}
	email, _ := p.Claims["email"].(string)
	verified, _ := p.Claims["email_verified"].(bool)
	name, _ := p.Claims["name"].(string)
	if p.Subject == "" || email == "" || !verified {
		return Identity{}, ErrUnauthorized
	}
	return Identity{p.Subject, strings.ToLower(email), name}, nil
}

type Users interface {
	UpsertUser(context.Context, string, string, string) (model.User, error)
	User(context.Context, string) (model.User, error)
}
type Service struct {
	Redis    *redis.Client
	Users    Users
	Verifier Verifier
	TTL      time.Duration
}

func Key(token string) string {
	sum := sha256.Sum256([]byte(token))
	return "worldsplat:session:" + hex.EncodeToString(sum[:])
}
func validToken(t string) bool {
	return len(t) >= 16 && len(t) <= 16384 && !strings.ContainsAny(t, " \r\n\t")
}
func (s *Service) Session(ctx context.Context, token string) (string, error) {
	if !validToken(token) {
		return "", ErrUnauthorized
	}
	id, e := s.Redis.Get(ctx, Key(token)).Result()
	if errors.Is(e, redis.Nil) {
		return "", ErrUnauthorized
	}
	if e != nil {
		return "", fmt.Errorf("session store unavailable: %w", e)
	}
	return id, nil
}
func (s *Service) Login(ctx context.Context, token string) (model.User, error) {
	id, e := s.Session(ctx, token)
	if e == nil {
		return s.Users.User(ctx, id)
	}
	if !errors.Is(e, ErrUnauthorized) {
		return model.User{}, e
	}
	if !validToken(token) {
		return model.User{}, ErrUnauthorized
	}
	ident, e := s.Verifier.Verify(ctx, token)
	if e != nil {
		return model.User{}, e
	}
	u, e := s.Users.UpsertUser(ctx, ident.Subject, ident.Email, ident.Name)
	if e != nil {
		return u, e
	}
	e = s.Redis.Set(ctx, Key(token), u.ID, s.TTL).Err()
	return u, e
}
func (s *Service) Logout(ctx context.Context, token string) error {
	return s.Redis.Del(ctx, Key(token)).Err()
}
