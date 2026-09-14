package pipeline

import (
	"context"
	"errors"
	"log/slog"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
	"worldsplat/internal/store"
)

func Dispatch(ctx context.Context, s *store.Store, c client.Client, queue string) {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		attempt, cancel := context.WithTimeout(ctx, 20*time.Second)
		ids, e := s.Pending(attempt)
		if e != nil {
			slog.Error("load pending jobs", "error", e)
		}
		for _, id := range ids {
			_, e = c.ExecuteWorkflow(attempt, client.StartWorkflowOptions{ID: "worldsplat-" + id, TaskQueue: queue, WorkflowIDReusePolicy: enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE, WorkflowExecutionErrorWhenAlreadyStarted: true}, WorkflowName, id)
			var already *serviceerror.WorkflowExecutionAlreadyStarted
			if e == nil || errors.As(e, &already) {
				if e = s.Dispatched(attempt, id); e != nil {
					slog.Error("mark dispatched", "job_id", id, "error", e)
				}
			} else {
				slog.Error("dispatch job", "job_id", id, "error", e)
			}
		}
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
