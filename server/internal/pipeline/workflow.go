package pipeline

import (
	"errors"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const WorkflowName = "WorldSplatRender"

func Render(ctx workflow.Context, id string) (string, error) {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 30 * time.Minute, ScheduleToCloseTimeout: 2 * time.Hour, HeartbeatTimeout: time.Minute, WaitForCancellation: true, RetryPolicy: &temporal.RetryPolicy{InitialInterval: 5 * time.Second, MaximumInterval: time.Minute, MaximumAttempts: 4}})
	for _, name := range []string{"RenderVisual", "RenderSplat"} {
		if err := workflow.ExecuteActivity(ctx, name, id).Get(ctx, nil); err != nil {
			cleanup, _ := workflow.NewDisconnectedContext(ctx)
			cleanup = workflow.WithActivityOptions(cleanup, workflow.ActivityOptions{StartToCloseTimeout: time.Minute, ScheduleToCloseTimeout: 24 * time.Hour, RetryPolicy: &temporal.RetryPolicy{InitialInterval: time.Second, MaximumInterval: time.Minute}})
			// Store a safe, actionable failure. Never copy raw provider bodies or SQL connection errors into the public job.
			message := name + " failed after retries; inspect backend logs using the job ID"
			var app *temporal.ApplicationError
			if temporal.IsCanceledError(err) {
				message = "render was cancelled"
			} else if errors.As(err, &app) {
				message = name + ": " + app.Message()
			}
			if cleanupErr := workflow.ExecuteActivity(cleanup, "FailJob", id, message).Get(cleanup, nil); cleanupErr != nil {
				return "", cleanupErr
			}
			return "", err
		}
	}
	return id, nil
}
